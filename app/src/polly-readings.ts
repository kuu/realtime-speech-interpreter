// Pronunciation readings for Amazon Polly (pure matching; the file loader at the bottom is the only I/O).
//
// Known Latin-script terms (MediaPackage, AVC, SCTE-35, ...) are wrapped in SSML
// <sub alias="katakana">TERM</sub> just before Polly, driven by assets/polly-readings.csv.
// Rules:
//   - matching is case-sensitive and exact; the longest term wins at each position
//   - a term matches only when it is not preceded or followed by [A-Za-z0-9]
//     (so "MediaPackageの", "「MediaPackage」", "SRT、" match; "HLSv2", "XSRT" do not)
//   - all text outside matches goes through escapeXml; the alias is escaped too, so neither the
//     Japanese text (LLM output) nor the file can inject SSML tags
import { readFileSync } from "node:fs";
import { escapeXml } from "./xml.js";
import { log } from "./log.js";

export interface ReadingEntry {
  term: string;
  reading: string;
}
export interface ParsedReadings {
  entries: ReadingEntry[];
  problems: string[]; // rows skipped
}
export interface ReadingsResult {
  inner: string; // SSML inner string (escaped text with <sub> tags)
  hits: number;
}
export interface Readings {
  readonly size: number;
  apply(text: string): ReadingsResult;
}

// CSV: optional '#' comment lines, a "term,reading" header, then one "term,reading" row per line.
// Terms and readings contain no commas or quotes (validate.mjs enforces this).
export function parseReadings(text: string): ParsedReadings {
  const entries: ReadingEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let header = false;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("#")) continue;
    const cols = line.split(",");
    if (!header) {
      header = true;
      if (cols.length === 2 && cols[0] === "term" && cols[1] === "reading") continue;
      problems.push(`line ${i + 1}: missing "term,reading" header`);
      continue;
    }
    if (cols.length !== 2) {
      problems.push(`line ${i + 1}: expected 2 columns, got ${cols.length}`);
      continue;
    }
    const [term, reading] = cols;
    if (term === "" || reading === "" || term !== term.trim() || reading !== reading.trim()) {
      problems.push(`line ${i + 1}: empty or whitespace-padded term/reading`);
      continue;
    }
    if (seen.has(term)) {
      problems.push(`line ${i + 1}: duplicate term "${term}" (first one kept)`);
      continue;
    }
    seen.add(term);
    entries.push({ term, reading });
  }
  return { entries, problems };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createReadings(entries: readonly ReadingEntry[]): Readings {
  const map = new Map<string, string>();
  for (const e of entries) if (!map.has(e.term)) map.set(e.term, e.reading);
  if (map.size === 0) {
    return { size: 0, apply: (text) => ({ inner: escapeXml(text), hits: 0 }) };
  }
  const terms = [...map.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${terms.map(escapeRegex).join("|")})(?![A-Za-z0-9])`, "gu");
  return {
    size: map.size,
    apply(text: string): ReadingsResult {
      let inner = "";
      let last = 0;
      let hits = 0;
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        inner += escapeXml(text.slice(last, m.index));
        inner += `<sub alias="${escapeXml(map.get(m[0]) as string)}">${escapeXml(m[0])}</sub>`;
        last = m.index + m[0].length;
        hits++;
      }
      inner += escapeXml(text.slice(last));
      return { inner, hits };
    },
  };
}

// ---- loader (startup) --------------------------------------------------------------------------
export interface ReadingsState {
  mode: "on" | "off";
  file: string;
  entries: number;
  loaded: boolean;
  readings: Readings | null; // null = off or load failed (the app runs without readings)
  error?: string;
}
let active: ReadingsState = { mode: "off", file: "", entries: 0, loaded: false, readings: null };

// Never throws: a missing or unreadable file is a loud WARN and the app runs without readings.
export function initReadings(mode: "on" | "off", file: string): ReadingsState {
  if (mode === "off") {
    active = { mode, file, entries: 0, loaded: false, readings: null };
    return active;
  }
  try {
    const parsed = parseReadings(readFileSync(file, "utf8"));
    for (const p of parsed.problems) log.warn(`[readings] ${file}: ${p}`);
    const readings = createReadings(parsed.entries);
    active = { mode, file, entries: readings.size, loaded: true, readings: readings.size > 0 ? readings : null };
  } catch (err) {
    const error = String(err);
    log.warn(`[readings] cannot load ${file}: ${error}; running WITHOUT pronunciation readings`);
    active = { mode, file, entries: 0, loaded: false, readings: null, error };
  }
  return active;
}
export function activeReadings(): Readings | null {
  return active.readings;
}
export function readingsStartupLine(s: ReadingsState = active): string {
  const status = s.mode === "off" ? "off" : s.loaded ? "on" : "on (LOAD FAILED, running without readings)";
  return `  pollyReadings=${status} file=${s.file} entries=${s.entries}`;
}
