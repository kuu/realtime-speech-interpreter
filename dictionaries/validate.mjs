#!/usr/bin/env node
// Validate the Transcribe custom vocabulary, the Translate custom terminology and the Polly readings
// before running cdk/scripts/dictionaries.sh. No dependencies; no AWS calls.
//
//   node dictionaries/validate.mjs [dir] [readingsFile]
//
// dir defaults to the resolved dictionary directory (DICTIONARY_DIR, else dictionaries/local, else
// dictionaries/example). readingsFile defaults to <dir>/polly-readings.csv.
// Exits 1 and prints every problem found if a file breaks the rules.
// Rules: summarised from the Transcribe custom-vocabulary table docs and the
// Translate custom-terminology docs.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDictionaryDir, settingFromEnv } from "./lib/dir.mjs";
let VOCAB = "";
let TERMS = "";
let READINGS = "";
const VOCAB_MAX_BYTES = 51200; // Transcribe: 50 KB per vocabulary file
const VOCAB_MAX_LINE = 256; // Transcribe: max chars per entry
const TERM_MAX_FIELD_BYTES = 200; // Translate: max source/target term length (bytes)
const TERM_MAX_FILE_BYTES = 10 * 1024 * 1024; // Translate: TerminologyData.File max
const VOCAB_HEADER = ["Phrase", "SoundsLike", "IPA", "DisplayAs"];

const errors = [];
const warnings = [];
const err = (file, line, msg) => errors.push(`${file}${line ? `:${line}` : ""}: ${msg}`);

// ---------- Transcribe vocabulary (table format, en-US) ----------
function validateVocabulary() {
  const name = "transcribe-vocabulary.txt";
  const buf = readFileSync(VOCAB);
  const size = statSync(VOCAB).size;
  if (size >= VOCAB_MAX_BYTES) err(name, 0, `file is ${size} bytes; must be < ${VOCAB_MAX_BYTES}`);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) err(name, 1, "file starts with a UTF-8 BOM");
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7e || (buf[i] < 0x20 && buf[i] !== 0x09 && buf[i] !== 0x0a && buf[i] !== 0x0d)) {
      err(name, 0, `non-ASCII or control byte 0x${buf[i].toString(16)} at offset ${i}`);
      break;
    }
  }
  const text = buf.toString("utf8");
  if (!text.endsWith("\n")) err(name, 0, "file must end with a newline");
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  if (header.join("\t") !== VOCAB_HEADER.join("\t")) {
    err(name, 1, `header must be "${VOCAB_HEADER.join("<TAB>")}", got "${lines[0].replace(/\t/g, "<TAB>")}"`);
  }
  const seen = new Map();
  let entries = 0;
  for (let n = 1; n < lines.length; n++) {
    const ln = n + 1;
    const line = lines[n];
    if (line === "") {
      err(name, ln, "blank line");
      continue;
    }
    if (line.length > VOCAB_MAX_LINE) err(name, ln, `line longer than ${VOCAB_MAX_LINE} chars`);
    const cols = line.split("\t");
    if (cols.length !== VOCAB_HEADER.length) {
      err(name, ln, `expected ${VOCAB_HEADER.length} TAB-separated columns, got ${cols.length}`);
      continue;
    }
    entries++;
    const [phrase, soundsLike, ipa, displayAs] = cols;
    for (const [col, v] of [["Phrase", phrase], ["SoundsLike", soundsLike], ["IPA", ipa], ["DisplayAs", displayAs]]) {
      if (v !== v.trim()) err(name, ln, `${col} has leading/trailing whitespace`);
    }
    checkPhrase(name, ln, phrase);
    // SoundsLike and IPA are no longer supported by Transcribe; values are ignored.
    // Contract: leave them empty (delimiters still present).
    if (soundsLike !== "") err(name, ln, `SoundsLike must be empty (Transcribe ignores it), got "${soundsLike}"`);
    if (ipa !== "") err(name, ln, `IPA must be empty (Transcribe ignores it), got "${ipa}"`);
    if (displayAs === "") err(name, ln, "DisplayAs must be filled (project convention)");
    const key = phrase.toLowerCase();
    if (seen.has(key)) err(name, ln, `duplicate Phrase "${phrase}" (first on line ${seen.get(key)})`);
    else seen.set(key, ln);
  }
  return { entries, size };
}

function checkPhrase(name, ln, p) {
  if (p === "") return err(name, ln, "Phrase is empty");
  if (/\s/.test(p)) return err(name, ln, `Phrase "${p}" contains whitespace (use hyphens between words)`);
  if (/[0-9]/.test(p)) return err(name, ln, `Phrase "${p}" contains digits (spell numbers out)`);
  if (!/^[A-Za-z'.-]+$/.test(p)) return err(name, ln, `Phrase "${p}" has characters outside the en-US set (a-z A-Z ' - .)`);
  if (/^[.'-]/.test(p)) err(name, ln, `Phrase "${p}" starts with . ' or -`);
  if (/['-]$/.test(p)) err(name, ln, `Phrase "${p}" ends with ' or -`);
  if (/--|\.\.|''/.test(p)) err(name, ln, `Phrase "${p}" has repeated -- .. or ''`);
  // Each hyphen-separated segment is either a word (letters/apostrophes) or an
  // acronym written as single letters each followed by a period (A.W.S.).
  for (const seg of p.split("-")) {
    if (seg.includes(".") && !/^([A-Za-z]\.)+$/.test(seg)) {
      err(name, ln, `Phrase "${p}": segment "${seg}" uses periods outside acronym form X.Y.Z. (trailing period required)`);
    }
  }
}

// ---------- Translate terminology (CSV, en -> ja) ----------
// RFC 4180 style parser so quoted fields are handled if anyone adds them.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== "") throw new Error(`line ${line}: quote inside an unquoted field`);
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      row.push({ v: field, q: wasQuoted });
      field = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push({ v: field, q: wasQuoted });
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = "";
      wasQuoted = false;
      line++;
      rowLine = line;
    } else {
      if (wasQuoted) throw new Error(`line ${line}: text after closing quote`);
      field += c;
    }
  }
  if (quoted) throw new Error("unterminated quoted field at end of file");
  if (field !== "" || row.length) {
    row.push({ v: field, q: wasQuoted });
    rows.push({ line: rowLine, cells: row });
  }
  return rows;
}

function validateTerminology() {
  const name = "translate-terminology.csv";
  const buf = readFileSync(TERMS);
  const size = statSync(TERMS).size;
  if (size > TERM_MAX_FILE_BYTES) err(name, 0, `file is ${size} bytes; must be <= ${TERM_MAX_FILE_BYTES}`);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) err(name, 1, "file starts with a UTF-8 BOM");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.includes("\uFFFD")) err(name, 0, "file is not valid UTF-8");
  if (!text.endsWith("\n")) err(name, 0, "file must end with a newline");
  let rows;
  try {
    rows = parseCsv(text);
  } catch (e) {
    err(name, 0, `CSV parse error: ${e.message}`);
    return { entries: 0, size };
  }
  if (rows.length === 0) {
    err(name, 1, "file is empty");
    return { entries: 0, size };
  }
  const header = rows[0].cells.map((c) => c.v);
  if (header.length !== 2 || header[0] !== "en" || header[1] !== "ja") {
    err(name, 1, `header must be exactly "en,ja", got "${header.join(",")}"`);
  }
  const seen = new Map();
  let entries = 0;
  for (const { line, cells } of rows.slice(1)) {
    if (cells.length === 1 && cells[0].v === "") {
      err(name, line, "blank line");
      continue;
    }
    if (cells.length !== 2) {
      err(name, line, `expected 2 columns, got ${cells.length}`);
      continue;
    }
    entries++;
    const [en, ja] = cells.map((c) => c.v);
    for (const [col, v] of [["en", en], ["ja", ja]]) {
      if (v.trim() === "") err(name, line, `${col} is empty`);
      if (v !== v.trim()) err(name, line, `${col} "${v}" has leading/trailing whitespace`);
      if (/[\t\r\n]/.test(v)) err(name, line, `${col} contains TAB or newline`);
      if (/[\u00a0\u3000]/.test(v)) err(name, line, `${col} contains a non-ASCII space (NBSP or full-width)`);
      const bytes = Buffer.byteLength(v, "utf8");
      if (bytes > TERM_MAX_FIELD_BYTES) err(name, line, `${col} is ${bytes} bytes; max ${TERM_MAX_FIELD_BYTES}`);
    }
    if (cells.some((c) => c.q)) err(name, line, "quoted field (contract: no quoting needed; avoid commas/quotes in terms)");
    const key = en.trim().toLowerCase();
    if (seen.has(key)) err(name, line, `duplicate en "${en}" (case-insensitive; first on line ${seen.get(key)})`);
    else seen.set(key, line);
  }
  return { entries, size };
}

// ---------- Polly readings (term,reading; app-side <sub alias> substitution) ----------
// Rules (app/src/polly-readings.ts): case-sensitive, longest term first, boundary = not next to [A-Za-z0-9].
// A reading is what Polly should say: katakana, hiragana, long-vowel mark, middle dot, spaces, digits,
// and the word AWS. No " < > & (the app escapes anyway; the file stays plain).
function validateReadings() {
  const name = "polly-readings.csv";
  const buf = readFileSync(READINGS);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) err(name, 1, "file starts with a UTF-8 BOM");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.includes("\uFFFD")) err(name, 0, "file is not valid UTF-8");
  if (!text.endsWith("\n")) err(name, 0, "file must end with a newline");
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let header = false;
  const terms = new Map(); // term -> {reading, line}
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("#")) {
      if (line.trim() === "" && i < lines.length - 1) err(name, ln, "blank line (use # comments)");
      continue;
    }
    const cols = line.split(",");
    if (!header) {
      header = true;
      if (cols.join(",") !== "term,reading") err(name, ln, `header must be exactly "term,reading", got "${line}"`);
      continue;
    }
    if (cols.length !== 2) {
      err(name, ln, `expected 2 columns (term,reading; no commas or quotes), got ${cols.length}`);
      continue;
    }
    const [term, reading] = cols;
    if (term.trim() === "") err(name, ln, "term is empty");
    if (reading.trim() === "") err(name, ln, `reading for "${term}" is empty`);
    if (term !== term.trim() || reading !== reading.trim()) err(name, ln, `"${term}": leading/trailing whitespace`);
    if (/[\t"<>&]/.test(term)) err(name, ln, `term "${term}" contains TAB, ", <, > or &`);
    if (/  /.test(term) || /  /.test(reading)) err(name, ln, `"${term}": double space`);
    if (/[\u00a0\u3000]/.test(term + reading)) err(name, ln, `"${term}": NBSP or full-width space`);
    if (/[\p{Script=Han}]/u.test(term)) err(name, ln, `term "${term}" must be Latin-script text`);
    const rest = reading.replace(/\bAWS\b/g, "");
    if (!/^[\p{Script=Katakana}\p{Script=Hiragana}ー・0-9 ]*$/u.test(rest)) {
      err(name, ln, `reading "${reading}" for "${term}" has characters outside katakana/hiragana/ー/space/digits (and the word AWS)`);
    }
    if (/\b[A-Za-z]/.test(rest)) err(name, ln, `reading "${reading}" for "${term}" contains Latin letters`);
    if (terms.has(term)) err(name, ln, `duplicate term "${term}" (first on line ${terms.get(term).line})`);
    else terms.set(term, { reading, line: ln });
  }
  if (!header) err(name, 1, "file has no header");
  // Longest-match notes: where a term contains a shorter term (at an app boundary), the longer wins in the
  // app. Warn when the longer reading does not contain the shorter reading (likely inconsistent).
  const squash = (x) => x.replace(/ /g, "");
  const inside = (long, short) => {
    for (let at = long.indexOf(short); at !== -1; at = long.indexOf(short, at + 1)) {
      const b = long[at - 1];
      const a = long[at + short.length];
      if (!(b && /[A-Za-z0-9]/.test(b)) && !(a && /[A-Za-z0-9]/.test(a))) return true;
    }
    return false;
  };
  for (const [long, L] of terms) {
    for (const [short, S] of terms) {
      if (long === short || long.length <= short.length || !inside(long, short)) continue;
      if (!squash(L.reading).includes(squash(S.reading))) {
        warnings.push(
          `${name}:${L.line}: "${long}" contains "${short}" (line ${S.line}) but its reading "${L.reading}" does not contain "${S.reading}"; the longer term wins in the app, check they agree`,
        );
      }
    }
  }
  return { entries: terms.size };
}
/** Validate the three generated files in `dir`. Returns { errors, warnings, counts }. */
export function validateDictionaryDir(dir, readingsFile) {
  VOCAB = join(dir, "transcribe-vocabulary.txt");
  TERMS = join(dir, "translate-terminology.csv");
  READINGS = readingsFile ?? join(dir, "polly-readings.csv");
  errors.length = 0;
  warnings.length = 0;
  const counts = {};
  for (const [key, fn] of [["vocabulary", validateVocabulary], ["terminology", validateTerminology], ["readings", validateReadings]]) {
    try {
      counts[key] = fn();
    } catch (e) {
      err(key, 0, `cannot read file: ${e.message}`);
      counts[key] = { entries: 0, size: 0 };
    }
  }
  return { errors: [...errors], warnings: [...warnings], counts };
}
function main() {
  let dir = process.argv[2];
  if (!dir) {
    const r = resolveDictionaryDir({ setting: settingFromEnv() });
    dir = r.dir;
    console.log(`Validating ${dir} (${r.source})`);
  }
  const { errors: errs, warnings: warns, counts } = validateDictionaryDir(dir, process.argv[3]);
  console.log(`transcribe-vocabulary.txt: ${counts.vocabulary.entries} entries, ${counts.vocabulary.size} bytes`);
  console.log(`translate-terminology.csv: ${counts.terminology.entries} entries, ${counts.terminology.size} bytes`);
  console.log(`polly-readings.csv: ${counts.readings.entries} entries`);
  for (const w of warns) console.warn(`WARN ${w}`);
  if (errs.length) {
    console.error(`\nFAILED: ${errs.length} problem(s)`);
    for (const e of errs) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log("OK: all files pass validation");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
