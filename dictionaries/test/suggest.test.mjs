import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/csv.mjs";
import { extractCandidates, isCommon, loadStoplist, logItems, parseCorrected, stripMarkdownLine, textItems } from "../lib/extract.mjs";
import { COLUMNS } from "../lib/terms.mjs";
import { FIX, build, cleanup, makeDict, stubBin, tmp } from "./helpers.mjs";

const stop = loadStoplist();
const items = (text, md = false) => textItems(text, { markdown: md }).map((i) => ({ source: `t:${i.line}`, text: i.text }));
const terms = (text, known) => extractCandidates(items(text), { stoplist: stop, known }).map((c) => c.term);
const proposal = (d) => parseCsv(readFileSync(join(d, "terms.proposed.csv"), "utf8"));

test("the stoplist is sorted, unique, lowercase and has at least 2000 words", () => {
  const words = readFileSync(join(import.meta.dirname, "..", "lib", "common-words.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.ok(words.length >= 2000, String(words.length));
  assert.deepEqual(words, [...new Set(words)].sort());
  assert.ok(words.every((w) => w === w.toLowerCase()));
});
test("inflections of common words count as common", () => {
  for (const w of ["settings", "organizations", "quickly", "recommended", "planning"]) assert.ok(isCommon(w, stop), w);
  assert.ok(!isCommon("quokkaform", stop));
});

test("extracts multi-word names, CamelCase, acronyms and ST 2110 style numbers", () => {
  const t = terms("We use AWS Elemental MediaPackage with MediaLive over HLS and SRT. ST 2110, SCTE-35 and H.264 matter. SigV4 and M3U8 too.", new Set());
  for (const want of ["AWS Elemental MediaPackage", "MediaLive", "HLS", "SRT", "ST 2110", "SCTE-35", "H.264", "SigV4", "M3U8"]) assert.ok(t.includes(want), `${want} in ${t}`);
});
test("a part inside a longer name is not proposed on its own", () => {
  const t = terms("We use AWS Elemental MediaPackage. We use AWS Elemental MediaPackage.", new Set());
  assert.ok(t.includes("AWS Elemental MediaPackage"));
  assert.ok(!t.includes("AWS") && !t.includes("MediaPackage") && !t.includes("Elemental"));
  const alone = terms("MediaPackage is part of AWS Elemental MediaPackage.", new Set());
  assert.ok(alone.includes("MediaPackage"));
});
test("ordinary words are not proposed", () => {
  const t = terms("The team said that the work is important. Today we meet in the afternoon. It is a good plan.", new Set());
  assert.deepEqual(t, []);
});
test("a capitalised first word of a sentence is not a name unless it repeats; mid-sentence names are", () => {
  assert.deepEqual(terms("Quokka sleeps all day.", new Set()), []);
  assert.deepEqual(terms("Quokka sleeps. Quokka eats.", new Set()), ["Quokka"]);
  assert.deepEqual(terms("We met Okafor today.", new Set()), ["Okafor"]);
});
test("rare lowercase words come last", () => {
  const t = terms("Use MediaLive. The transmuxing step is quick.", new Set());
  assert.deepEqual(t, ["MediaLive", "transmuxing"]);
});
test("dedupe against known terms is case-insensitive; the most frequent spelling wins", () => {
  assert.deepEqual(terms("Use MediaLive.", new Set(["medialive"])), []);
  const t = terms("Use Medialive and MediaLive and MediaLive.", new Set());
  assert.ok(!t.includes("Medialive"));
});
test("markdown syntax, links and code fences are ignored", () => {
  assert.equal(stripMarkdownLine("- **Bold** [link text](https://example.com/Path) `code`"), "Bold link text code");
  const it = textItems("```\nFooBar baz\n```\nreal FooBar line\n", { markdown: true });
  assert.deepEqual(it, [{ line: 4, text: "real FooBar line" }]);
});
test("the log: COMMIT en= text and [corrected: a -> b] are parsed with line numbers", () => {
  const log = readFileSync(join(FIX, "rehearsal-log.txt"), "utf8");
  const l = logItems(log, "app.log");
  assert.equal(l.items.length, 3);
  assert.equal(l.items[0].source, "app.log:2");
  assert.deepEqual(parseCorrected("x [corrected: a -> b, c d -> e]"), [{ from: "a", to: "b" }, { from: "c d", to: "e" }]);
  assert.equal(l.corrections.length, 3);
});

test("suggest: proposal file has the terms.csv header, one line per term, source file:line, empty ja/reading", () => {
  const d = makeDict("");
  const r = build(["suggest", "--from", join(FIX, "announcement.md"), "--dir", d]);
  assert.equal(r.status, 0, r.all);
  const rows = proposal(d);
  assert.deepEqual(rows[0].cells, COLUMNS);
  const col = (n) => COLUMNS.indexOf(n);
  const byEn = new Map(rows.slice(1).map((x) => [x.cells[col("en")], x.cells]));
  for (const want of ["AWS Elemental MediaPackage", "AuroraLive", "StreamDeck", "ST 2110", "SCTE-35", "HLS", "SRT", "Maria Lindqvist", "transmuxing"]) assert.ok(byEn.has(want), want);
  assert.equal(byEn.size, rows.length - 1, "one line per term");
  for (const cells of byEn.values()) {
    assert.match(cells[col("source")], /announcement\.md:\d+$/);
    assert.equal(cells[col("ja")], "");
    assert.equal(cells[col("reading")], "");
  }
  assert.match(byEn.get("AWS Elemental MediaPackage")[col("source")], /announcement\.md:4$/);
  assert.equal(byEn.get("HLS")[col("transcribe_en")], "y");
  assert.equal(byEn.get("ST 2110")[col("transcribe_en")], "", "a phrase is needed for digits");
  cleanup(d);
});
test("suggest is deterministic and never changes terms.csv", () => {
  const d = makeDict("HLS,HLS,エイチエルエス,y,y,y,,,,,,,\n");
  const before = readFileSync(join(d, "terms.csv"));
  const a = build(["suggest", "--from", join(FIX, "announcement.md"), "--dir", d]);
  const first = readFileSync(join(d, "terms.proposed.csv"), "utf8");
  const b = build(["suggest", "--from", join(FIX, "announcement.md"), "--dir", d, "--force"]);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(readFileSync(join(d, "terms.proposed.csv"), "utf8"), first);
  assert.deepEqual(readFileSync(join(d, "terms.csv")), before);
  assert.ok(!first.split("\n").some((l) => l.startsWith("HLS,")), "known term HLS is left out");
  cleanup(d);
});
test("an existing proposal is not overwritten without --force", () => {
  const d = makeDict("");
  writeFileSync(join(d, "terms.proposed.csv"), "mine\n");
  const r = build(["suggest", "--from", join(FIX, "announcement.md"), "--dir", d]);
  assert.equal(r.status, 1);
  assert.match(r.err, /already exists/);
  assert.equal(readFileSync(join(d, "terms.proposed.csv"), "utf8"), "mine\n");
  cleanup(d);
});
test("--from-log: corrected words get a note with what was heard and how often", () => {
  const d = makeDict("");
  const r = build(["suggest", "--from-log", join(FIX, "rehearsal-log.txt"), "--dir", d]);
  assert.equal(r.status, 0, r.all);
  const rows = proposal(d).slice(1).map((x) => x.cells);
  const v = rows.find((c) => c[0] === "verticalization");
  assert.match(v[COLUMNS.indexOf("notes")], /corrected; heard as "fertilization" 2 times/);
  assert.match(v[COLUMNS.indexOf("source")], /rehearsal\.log:3$/);
  assert.ok(rows.some((c) => c[0] === "quokkaform"));
  cleanup(d);
});
test("with no input it is an error; with only unreadable input nothing is written", () => {
  const d = makeDict("");
  assert.equal(build(["suggest", "--dir", d]).status, 1);
  const r = build(["suggest", "--from", "/nonexistent/file.txt", "--dir", d]);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(d, "terms.proposed.csv")));
  cleanup(d);
});
test("a PDF is read through pdftotext (stub), with the page in the source", () => {
  const d = makeDict("");
  const pdf = join(tmp("pdf-"), "deck.pdf");
  writeFileSync(pdf, "%PDF-1.4 stub");
  const bin = stubBin("pdftotext", `printf 'Intro slide\\n\\fWe ship StreamDeck today\\n'`);
  const r = build(["suggest", "--from", pdf, "--dir", d], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.all);
  const row = proposal(d).slice(1).find((x) => x.cells[0] === "StreamDeck");
  assert.match(row.cells[COLUMNS.indexOf("source")], /deck\.pdf:p2:1$/);
  cleanup(d, bin);
});
test("without pdftotext a PDF is skipped with an install hint; a text file still works; PDF alone fails", () => {
  const d = makeDict("");
  const pdf = join(tmp("pdf-"), "deck.pdf");
  writeFileSync(pdf, "%PDF-1.4 stub");
  const empty = tmp("empty-path-");
  const both = build(["suggest", "--from", pdf, "--from", join(FIX, "announcement.md"), "--dir", d], { env: { PATH: empty } });
  assert.equal(both.status, 0, both.all);
  assert.match(both.err, /pdftotext is not installed.*brew install poppler/);
  const only = build(["suggest", "--from", pdf, "--dir", d, "--force"], { env: { PATH: empty } });
  assert.equal(only.status, 1);
  assert.match(only.err, /none of the inputs could be read/);
  cleanup(d, empty);
});
test("--wordlist adds words to the stoplist", () => {
  const d = makeDict("");
  const wl = join(tmp("wl-"), "words.txt");
  writeFileSync(wl, "transmuxing\nbaseband\n");
  assert.equal(build(["suggest", "--from", join(FIX, "announcement.md"), "--dir", d, "--wordlist", wl]).status, 0);
  const names = proposal(d).slice(1).map((x) => x.cells[0]);
  assert.ok(!names.includes("transmuxing") && !names.includes("baseband"));
  cleanup(d);
});
