#!/usr/bin/env node
// Dictionary builder: one source file (terms.csv) generates the Transcribe vocabulary, the Translate
// terminology and the Polly readings. No dependencies. Docs: docs/dictionaries.md
//
//   node dictionaries/build.mjs generate [--dir D] [--check]
//   node dictionaries/build.mjs where    [--dir D]
//   node dictionaries/build.mjs init     [--empty]
//   node dictionaries/build.mjs suggest  --from FILE [--from FILE ...] [--from-log LOG] [--dir D] ...
//   node dictionaries/build.mjs merge    [--dir D] [--yes]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { askBedrock, buildRequest, costUsd, defaultModelId, defaultRegion, estimateCost, formatUsd, pricesFor } from "./lib/bedrock.mjs";
import { parseCsv, serializeCsv } from "./lib/csv.mjs";
import { REPO_ROOT, resolveDictionaryDir, settingFromEnv } from "./lib/dir.mjs";
import { extractCandidates, loadStoplist, logItems, textItems } from "./lib/extract.mjs";
import { COLUMNS, OPTIONAL_OUTPUT_FILES, OUTPUT_FILES, TERMS_HEADER, TermsError, derivePhrase, parseTerms } from "./lib/terms.mjs";
import { validateDictionaryDir } from "./validate.mjs";

const out = (s) => process.stdout.write(s + "\n");
const errOut = (s) => process.stderr.write(s + "\n");

/** Tiny option parser: --flag, --opt value, repeatable options collected into arrays. */
export function parseArgs(argv, spec) {
  const o = {};
  for (const [k, def] of Object.entries(spec)) o[k] = def === "list" ? [] : def === "bool" ? false : undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    if (!(key in spec)) throw new Error(`unknown option --${key}`);
    if (spec[key] === "bool") o[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${key} needs a value`);
      if (spec[key] === "list") o[key].push(v);
      else o[key] = v;
    }
  }
  return o;
}

/** Resolve the dictionary dir for a command. `write` commands refuse the committed example unless --dir was explicit. */
export function targetDir(opts, { write }) {
  const setting = opts.dir ?? settingFromEnv();
  const root = opts.root ? resolve(opts.root) : REPO_ROOT;
  const r = resolveDictionaryDir({ setting, root });
  if (write && r.source === "example") {
    throw new Error(
      "no local dictionary yet. Run `node dictionaries/build.mjs init` to create dictionaries/local/ from the example, or pass --dir.",
    );
  }
  return r;
}

export function readTerms(dir) {
  const f = join(dir, "terms.csv");
  if (!existsSync(f)) throw new Error(`missing ${f}. Run \`node dictionaries/build.mjs init\` or create it (see docs/dictionaries.md).`);
  return parseTerms(readFileSync(f, "utf8"));
}

// The three files of today, always; the reverse-direction files only when at least one row has their flag.
export function renderAll(rows) {
  const files = Object.fromEntries(Object.entries(OUTPUT_FILES).map(([name, fn]) => [name, fn(rows)]));
  for (const [name, fn] of Object.entries(OPTIONAL_OUTPUT_FILES)) {
    const text = fn(rows);
    if (text !== null) files[name] = text;
  }
  return files;
}

function firstDiff(want, have) {
  const a = want.split("\n");
  const b = have.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: generated ${JSON.stringify(a[i] ?? "<end of file>")}, on disk ${JSON.stringify(b[i] ?? "<end of file>")}`;
  }
  return "content differs";
}

/** Compare generated output with the files in `dir`. Returns an array of problem strings (empty means in sync). */
export function checkDir(dir) {
  const { rows } = readTerms(dir);
  const problems = [];
  const rendered = renderAll(rows);
  for (const name of Object.keys(OPTIONAL_OUTPUT_FILES)) {
    if (!(name in rendered) && existsSync(join(dir, name))) problems.push(`${name}: exists but terms.csv has no rows for it (run generate to remove it)`);
  }
  for (const [name, text] of Object.entries(rendered)) {
    const f = join(dir, name);
    if (!existsSync(f)) problems.push(`${name}: missing (run generate)`);
    else {
      const have = readFileSync(f, "utf8");
      if (have !== text) problems.push(`${name}: differs from terms.csv, ${firstDiff(text, have)}`);
    }
  }
  return problems;
}

/** Generate the three files into `dir`. Output is validated in a temp dir first; invalid output never replaces good files. */
export function generate(dir) {
  const { rows, notices, warnings: termWarnings } = readTerms(dir);
  const files = renderAll(rows);
  const tmp = mkdtempSync(join(tmpdir(), "dict-gen-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text);
    const v = validateDictionaryDir(tmp);
    if (v.errors.length) throw new TermsError(v.errors.map((e) => `generated ${e}`));
    for (const [name, text] of Object.entries(files)) {
      const stage = join(dir, `.${name}.tmp`);
      writeFileSync(stage, text);
      renameSync(stage, join(dir, name));
    }
    // A generated optional file whose rows are gone is removed, so a stale vocabulary or terminology is never uploaded.
    for (const name of Object.keys(OPTIONAL_OUTPUT_FILES)) if (!(name in files)) rmSync(join(dir, name), { force: true });
    return { counts: v.counts, warnings: [...termWarnings, ...v.warnings], notices };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function cmdGenerate(argv) {
  const o = parseArgs(argv, { dir: undefined, root: undefined, check: "bool" });
  const { dir, source } = targetDir(o, { write: !o.check });
  if (o.check) {
    const problems = checkDir(dir);
    if (problems.length) {
      errOut(`Generated files in ${dir} are out of date:`);
      for (const p of problems) errOut(`  ${p}`);
      errOut("Edit terms.csv, then run: node dictionaries/build.mjs generate" + (source === "example" ? " --dir dictionaries/example" : ""));
      return 1;
    }
    out(`OK: generated files in ${dir} match terms.csv`);
    return 0;
  }
  const r = generate(dir);
  for (const n of r.notices) out(`note: ${n}`);
  out(`Generated from ${join(dir, "terms.csv")} (${source}):`);
  out(`  transcribe-vocabulary.txt: ${r.counts.vocabulary.entries} entries`);
  out(`  translate-terminology.csv: ${r.counts.terminology.entries} entries`);
  out(`  polly-readings.csv: ${r.counts.readings.entries} entries`);
  if (r.counts.vocabularyJa) out(`  transcribe-vocabulary-ja.txt: ${r.counts.vocabularyJa.entries} entries`);
  if (r.counts.readingsEn) out(`  polly-readings-en.csv: ${r.counts.readingsEn.entries} entries`);
  for (const w of r.warnings) out(`WARN ${w}`);
  return 0;
}

function cmdWhere(argv) {
  const o = parseArgs(argv, { dir: undefined, root: undefined });
  const { dir, source } = targetDir(o, { write: false });
  out(`${dir}\t${source}`);
  return 0;
}

function cmdInit(argv) {
  const o = parseArgs(argv, { empty: "bool", root: undefined });
  const root = o.root ? resolve(o.root) : REPO_ROOT;
  const local = join(root, "dictionaries", "local");
  if (existsSync(local)) throw new Error(`${local} already exists; nothing to do`);
  mkdirSync(local, { recursive: true });
  if (o.empty) writeFileSync(join(local, "terms.csv"), TERMS_HEADER);
  else copyFileSync(join(root, "dictionaries", "example", "terms.csv"), join(local, "terms.csv"));
  out(`Created ${local}/terms.csv (${o.empty ? "header only" : "copied from the example"}). This folder is gitignored.`);
  const r = generate(local);
  out(`Generated ${r.counts.vocabulary.entries}/${r.counts.terminology.entries}/${r.counts.readings.entries} entries (vocabulary/terminology/readings).`);
  out("Back it up yourself: git does not track it.");
  return 0;
}

// ---------- suggest ----------
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Items from one --from file. Returns { items, problem } where problem is a message when the file was skipped. */
function readInput(file) {
  if (!existsSync(file)) return { problem: `${file}: file not found` };
  if (/\.pdf$/i.test(file)) {
    const r = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.error) {
      const hint = r.error.code === "ENOENT" ? "pdftotext is not installed (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils)" : r.error.message;
      return { problem: `${file}: skipped, ${hint}. Export the text yourself (.txt or .md) and pass that.` };
    }
    if (r.status !== 0) return { problem: `${file}: pdftotext failed (${(r.stderr || "").trim().split("\n").pop()})` };
    const items = [];
    r.stdout.split("\f").forEach((page, p) => {
      for (const it of textItems(page)) items.push({ source: `${file}:p${p + 1}:${it.line}`, text: it.text });
    });
    return { items };
  }
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return { problem: `${file}: skipped, binary file (give .txt, .md or .pdf)` };
  const markdown = /\.(md|markdown)$/i.test(file);
  return { items: textItems(buf.toString("utf8"), { markdown }).map((it) => ({ source: `${file}:${it.line}`, text: it.text })) };
}

function knownTerms(dir) {
  const f = join(dir, "terms.csv");
  const known = new Set();
  if (!existsSync(f)) return known;
  const { rows } = parseTerms(readFileSync(f, "utf8"));
  for (const r of rows) for (const v of [r.en, r.phrase, r.display_as, r._display]) if (v) known.add(v.toLowerCase());
  return known;
}

function proposalRow(c) {
  const r = Object.fromEntries(COLUMNS.map((k) => [k, ""]));
  r.en = c.term;
  r.source = c.source;
  const notes = [c.kind === "corrected" ? c.note : `${c.kind}; ${c.count} occurrence${c.count === 1 ? "" : "s"}`];
  if (c.kind !== "corrected" && c.also.length) notes.push(`also ${c.also.join(", ")}`);
  try {
    derivePhrase(c.term);
    r.transcribe_en = "y";
  } catch {
    notes.push("Transcribe: write the phrase by hand (spell numbers out, plain letters only), then set transcribe_en=y");
  }
  r.notes = notes.join("; ");
  return r;
}

async function cmdSuggest(argv) {
  const o = parseArgs(argv, {
    from: "list", "from-log": "list", dir: undefined, root: undefined, out: undefined, force: "bool", wordlist: "list",
    "suggest-with-bedrock": "bool", model: undefined, region: undefined, "max-terms": undefined,
  });
  if (o.from.length === 0 && o["from-log"].length === 0) throw new Error("give at least one --from FILE or --from-log LOG");
  const root = o.root ? resolve(o.root) : REPO_ROOT;
  const { dir } = targetDir(o, { write: !o.out });
  const known = knownTerms(dir);
  const stoplist = loadStoplist(o.wordlist);
  const items = [];
  const corrections = [];
  let readable = 0;
  for (const f of o.from) {
    const r = readInput(f);
    if (r.problem) errOut(`warning: ${r.problem}`);
    else {
      readable++;
      items.push(...r.items);
    }
  }
  for (const f of o["from-log"]) {
    if (!existsSync(f)) {
      errOut(`warning: ${f}: file not found`);
      continue;
    }
    readable++;
    const l = logItems(readFileSync(f, "utf8"), f);
    items.push(...l.items);
    corrections.push(...l.corrections);
  }
  if (readable === 0) {
    errOut("error: none of the inputs could be read; nothing written");
    return 1;
  }
  const cands = extractCandidates(items, { stoplist, known });
  // Words the app's corrections.ts replaced: propose the corrected form, note what was heard.
  const byTo = new Map();
  for (const c of corrections) {
    const k = c.to.toLowerCase();
    if (known.has(k)) continue;
    const e = byTo.get(k) ?? { term: c.to, from: new Map(), count: 0, source: c.source };
    e.count++;
    e.from.set(c.from, (e.from.get(c.from) ?? 0) + 1);
    byTo.set(k, e);
  }
  for (const [k, e] of byTo) {
    const heard = [...e.from].map(([w, n]) => `"${w}" ${n} time${n === 1 ? "" : "s"}`).join(", ");
    const note = `corrected; heard as ${heard}`;
    const at = cands.findIndex((c) => c.term.toLowerCase() === k);
    const entry = { term: e.term, kind: "corrected", count: e.count, source: e.source, also: [], note, score: 95 + Math.min(e.count, 10) };
    if (at >= 0) cands.splice(at, 1);
    cands.push(entry);
  }
  cands.sort((a, b) => b.score - a.score || (a.order ?? 1e9) - (b.order ?? 1e9));
  const rows = cands.map((c) => ({ c, row: proposalRow(c) }));

  const outFile = o.out ? resolve(o.out) : join(dir, "terms.proposed.csv");
  if (existsSync(outFile) && !o.force) {
    if (!(await confirm(`${outFile} exists. Overwrite? [y/N] `))) {
      errOut(`error: ${outFile} already exists. Review it and run merge, or pass --force to overwrite.`);
      return 1;
    }
  }
  if (o["suggest-with-bedrock"] && rows.length) await bedrockFill(rows, o, root);
  writeFileSync(outFile, serializeCsv([COLUMNS, ...rows.map(({ row }) => COLUMNS.map((k) => row[k]))]));
  out(`${rows.length} candidate term${rows.length === 1 ? "" : "s"} written to ${outFile} (terms.csv was not changed)`);
  const shown = rows.slice(0, 25);
  const w = Math.max(4, ...shown.map(({ row }) => row.en.length));
  for (const { c, row } of shown) out(`  ${row.en.padEnd(w)}  ${c.kind.padEnd(14)} x${String(c.count).padEnd(3)} ${row.source}`);
  if (rows.length > shown.length) out(`  ... and ${rows.length - shown.length} more in the file`);
  out("Next: open the file, fill ja / reading, set the flags you want, delete rows you do not need, then: node dictionaries/build.mjs merge");
  return 0;
}

async function bedrockFill(rows, o, root) {
  const n = Math.max(1, Number(o["max-terms"] ?? 50));
  if (!Number.isInteger(n)) throw new Error("--max-terms must be a whole number");
  const subset = rows.slice(0, n);
  const modelId = defaultModelId({ model: o.model, root });
  const region = defaultRegion({ region: o.region });
  const terms = subset.map(({ row }) => ({ term: row.en }));
  const est = estimateCost(buildRequest(terms), terms.length, modelId, root);
  errOut(
    `Bedrock suggestions for ${terms.length} term(s) with ${modelId} in ${region}: ` +
      `about ${est.inputTokens} input tokens and up to ${est.outputTokens} output tokens, ${formatUsd(est.usd)}.`,
  );
  const { suggestions, usage } = askBedrock(terms, { modelId, region });
  const pr = pricesFor(modelId, root);
  errOut(`Bedrock usage: ${usage.inputTokens} input and ${usage.outputTokens} output tokens, ${formatUsd(costUsd(usage.inputTokens, usage.outputTokens, pr))}.`);
  let filled = 0;
  for (const { row } of subset) {
    const s = suggestions.get(row.en);
    if (!s || (!s.ja && !s.reading)) continue;
    if (s.ja) row.ja = s.ja;
    if (s.reading) row.reading = s.reading;
    row.notes = `UNVERIFIED (bedrock ${modelId}); ${row.notes}`;
    filled++;
  }
  errOut(`${filled} of ${terms.length} term(s) got a suggestion. Check every one before you merge; flags stay as they were.`);
}

// ---------- merge ----------
async function cmdMerge(argv) {
  const o = parseArgs(argv, { dir: undefined, root: undefined, proposed: undefined, yes: "bool" });
  const { dir } = targetDir(o, { write: true });
  const termsFile = join(dir, "terms.csv");
  const propFile = o.proposed ? resolve(o.proposed) : join(dir, "terms.proposed.csv");
  if (!existsSync(propFile)) throw new Error(`no proposal at ${propFile}. Run suggest first.`);
  const current = readTerms(dir);
  const known = new Set();
  for (const r of current.rows) for (const v of [r.en, r.phrase, r.display_as, r._display]) if (v) known.add(v.toLowerCase());

  // Read the proposal leniently: drop rows with an empty en, then validate with the same rules as terms.csv.
  const table = parseCsv(readFileSync(propFile, "utf8"));
  if (table.length === 0) throw new Error(`${propFile} is empty`);
  const head = table[0].cells.map((c) => c.trim());
  const enAt = head.indexOf("en");
  if (enAt < 0) throw new Error(`${propFile} has no "en" column`);
  const kept = table.slice(1).filter((r) => (r.cells[enAt] ?? "").trim() !== "");
  const proposal = parseTerms(serializeCsv([head, ...kept.map((r) => r.cells)]), "terms.proposed.csv");
  const fresh = proposal.rows.filter((r) => !known.has(r.en.toLowerCase()));
  const dropped = proposal.rows.length - fresh.length;
  if (fresh.length === 0) {
    out(`Nothing to merge (${dropped} already in terms.csv, ${table.length - 1 - kept.length} empty row(s) dropped).`);
    return 0;
  }
  // Append in the column order of terms.csv.
  const existingText = readFileSync(termsFile, "utf8");
  const termsHead = parseCsv(existingText)[0].cells.map((c) => c.trim());
  const add = fresh.map((r) => termsHead.map((h) => (r[h] === null || r[h] === undefined ? "" : String(r[h]))));
  const next = (existingText.endsWith("\n") ? existingText : existingText + "\n") + serializeCsv(add);
  parseTerms(next); // the merged file must be valid; throws with line numbers otherwise
  out(`Rows to append to ${termsFile} (${fresh.length}${dropped ? `, ${dropped} already known and skipped` : ""}):`);
  for (const r of fresh.slice(0, 20)) out(`  + ${r.en}${r.ja ? `  ->  ${r.ja}` : ""}${r.reading ? `  (${r.reading})` : ""}`);
  if (fresh.length > 20) out(`  ... and ${fresh.length - 20} more`);
  if (!o.yes && !(await confirm(`Append ${fresh.length} rows to terms.csv? [y/N] `))) {
    errOut(process.stdin.isTTY ? "Not merged." : "Not merged: no terminal to confirm on. Run again in a terminal, or pass --yes.");
    return 1;
  }
  const stage = join(dir, ".terms.csv.tmp");
  writeFileSync(stage, next);
  renameSync(stage, termsFile);
  out(`Appended ${fresh.length} rows. Now run: node dictionaries/build.mjs generate${dir === join(REPO_ROOT, "dictionaries", "local") ? "" : ` --dir ${dir}`}`);
  return 0;
}

const COMMANDS = { generate: cmdGenerate, where: cmdWhere, init: cmdInit, suggest: cmdSuggest, merge: cmdMerge };

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || !COMMANDS[cmd]) {
    out("usage: node dictionaries/build.mjs <generate|where|init|suggest|merge> [options]  (see docs/dictionaries.md)");
    return cmd && cmd !== "-h" && cmd !== "--help" ? 2 : 0;
  }
  try {
    return await COMMANDS[cmd](rest);
  } catch (e) {
    if (e instanceof TermsError) for (const m of e.errors) errOut(m);
    else errOut(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
