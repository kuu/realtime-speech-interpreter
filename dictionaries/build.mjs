#!/usr/bin/env node
// Dictionary builder: one source file (terms.csv) generates the Transcribe vocabulary, the Translate
// terminology and the Polly readings. No dependencies. Docs: docs/dictionaries.md
//
//   node dictionaries/build.mjs generate [--dir D] [--check]
//   node dictionaries/build.mjs where    [--dir D]
//   node dictionaries/build.mjs init     [--empty]
//   node dictionaries/build.mjs suggest  --from FILE [--from FILE ...] [--from-log LOG] [--dir D] ...
//   node dictionaries/build.mjs merge    [--dir D] [--yes]
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, resolveDictionaryDir, settingFromEnv } from "./lib/dir.mjs";
import { OUTPUT_FILES, TERMS_HEADER, TermsError, parseTerms } from "./lib/terms.mjs";
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

export function renderAll(rows) {
  return Object.fromEntries(Object.entries(OUTPUT_FILES).map(([name, fn]) => [name, fn(rows)]));
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
  for (const [name, text] of Object.entries(renderAll(rows))) {
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
  const { rows, notices } = readTerms(dir);
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
    return { counts: v.counts, warnings: v.warnings, notices };
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

const COMMANDS = { generate: cmdGenerate, where: cmdWhere, init: cmdInit };

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
