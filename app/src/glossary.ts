// Glossary for the LLM engine: the deployed Amazon Translate terminology (same terms the Translate
// fallback uses), fetched at startup with translate:GetTerminology (CSV, presigned S3 URL).
// Pure parsing here; the fetch is injected so it can be tested.

import { GetTerminologyCommand } from "@aws-sdk/client-translate";

// [source, target] of the lane's direction: [en, ja] for the English-to-Japanese lane (today), [ja, en] for the reverse.
export type GlossaryEntry = [en: string, ja: string];
export type GlossaryDirection = "en-ja" | "ja-en";

// Parse CSV text: optional BOM, CRLF or LF, quoted fields ("" escapes a quote, quoted commas),
// header row `en,ja`, blank lines ignored. A duplicate English key keeps the first entry.
// Direction ja-en: entries are [ja, en] and the duplicate key is the NFKC-normalised Japanese column (the first row wins). It
// reads the deployed multi-directional terminology (header `en,ja`, the same file the en-ja lane reads, columns swapped) and,
// for older deployments, a uni-directional file with header `ja,en`.
export function parseTerminologyCsv(csv: string, direction: GlossaryDirection = "en-ja"): GlossaryEntry[] {
  const text = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  const first = rows.find((r) => r.length >= 2);
  const swapped = !!first && first[0].trim().toLowerCase() === "en" && first[1].trim().toLowerCase() === "ja";
  for (const r of rows) {
    if (r.length < 2) continue;
    const en = r[0].trim();
    const ja = r[1].trim();
    if (!en || !ja) continue;
    if (direction === "ja-en") {
      if (en.toLowerCase() === "ja" && ja.toLowerCase() === "en") continue;
      if (swapped && en.toLowerCase() === "en" && ja.toLowerCase() === "ja") continue;
      const [jaTerm, enTerm] = swapped ? [ja, en] : [en, ja];
      const jaKey = jaTerm.normalize("NFKC").toLowerCase();
      if (seen.has(jaKey)) continue;
      seen.add(jaKey);
      out.push([jaTerm, enTerm]);
      continue;
    }
    if (en.toLowerCase() === "en" && ja.toLowerCase() === "ja") continue;
    const key = en.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([en, ja]);
  }
  return out;
}

// One `English = 日本語` line per entry (`日本語 = English` for ja-en), in terminology order.
export function glossaryLines(entries: readonly GlossaryEntry[]): string {
  return entries.map(([en, ja]) => `${en} = ${ja}`).join("\n");
}

export interface TerminologyClient {
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
}
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

// Loads the deployed terminology. Rejects on any failure (API error, HTTP error, timeout,
// empty or unparsable CSV); the caller disables the LLM engine for the session.
export async function loadDeployedGlossary(
  translateClient: TerminologyClient,
  name: string,
  fetchFn: FetchFn,
  timeoutMs: number,
  direction: GlossaryDirection = "en-ja",
): Promise<GlossaryEntry[]> {
  if (!name) throw new Error("no terminology name configured (TRANSLATE_TERMINOLOGY is empty)");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await translateClient.send(new GetTerminologyCommand({ Name: name, TerminologyDataFormat: "CSV" }), { abortSignal: ac.signal });
    const url: string | undefined = res?.TerminologyDataLocation?.Location;
    if (!url) throw new Error("GetTerminology returned no download location");
    const r = await fetchFn(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`terminology download failed: HTTP ${r.status}`);
    const entries = parseTerminologyCsv(await r.text(), direction);
    if (entries.length === 0) throw new Error("terminology CSV has no entries");
    return entries;
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`glossary load timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
