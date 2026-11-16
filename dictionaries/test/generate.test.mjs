import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/csv.mjs";
import { derivePhrase, parseTerms, renderReadings, renderTerminology, renderVocabulary } from "../lib/terms.mjs";
import { HEADER, build, cleanup, makeDict, tmp } from "./helpers.mjs";

const read = (d, f) => readFileSync(join(d, f), "utf8");
const GOOD = [
  "AWS Elemental MediaPackage,AWS Elemental MediaPackage,AWS エレメンタル メディアパッケージ,y,y,y,,,,,,,",
  "HLS,HLS,エイチエルエス,y,y,y,,,,,,,",
  "Speke,,,y,,,speaky,SPEKE,,,,,",
  "SPEKE,SPEKE,スピーク,y,y,y,Speke,,,,,,",
].join("\n") + "\n";

test("derivePhrase table", () => {
  const t = {
    MediaPackage: "Media-Package",
    CloudFront: "Cloud-Front",
    HDR: "H.D.R.",
    "AWS Elemental": "A.W.S.-Elemental",
    "Elemental Link HD": "Elemental-Link-H.D.",
    "Link UHD": "Link-U.H.D.",
    "AWS Elemental Media Services": "A.W.S.-Elemental-Media-Services",
    AEMS: "A.E.M.S.",
    verticalization: "verticalization",
    "MediaConnect flow": "Media-Connect-flow",
  };
  for (const [display, phrase] of Object.entries(t)) assert.equal(derivePhrase(display), phrase, display);
  assert.throws(() => derivePhrase("MediaPackage v2"), /phrase required/);
  assert.throws(() => derivePhrase("SCTE-35"), /phrase required/);
});

test("generate then check round-trips; outputs are LF, no BOM, trailing newline", () => {
  const d = makeDict(GOOD);
  const g = build(["generate", "--dir", d]);
  assert.equal(g.status, 0, g.all);
  const v = read(d, "transcribe-vocabulary.txt");
  assert.equal(v, "Phrase\tSoundsLike\tIPA\tDisplayAs\nA.W.S.-Elemental-Media-Package\t\t\tAWS Elemental MediaPackage\nH.L.S.\t\t\tHLS\nspeaky\t\t\tSPEKE\nSpeke\t\t\tSPEKE\n");
  assert.equal(read(d, "translate-terminology.csv"), "en,ja\nAWS Elemental MediaPackage,AWS Elemental MediaPackage\nHLS,HLS\nSPEKE,SPEKE\n");
  const p = read(d, "polly-readings.csv");
  assert.match(p, /\nterm,reading\nAWS Elemental MediaPackage,AWS エレメンタル メディアパッケージ\nHLS,エイチエルエス\nSPEKE,スピーク\n$/);
  assert.ok(!p.includes("\r") && !p.startsWith("\uFEFF"));
  assert.equal(build(["generate", "--check", "--dir", d]).status, 0);
  cleanup(d);
});

test("--check fails after a hand edit to each generated file and names the file and line", () => {
  for (const f of ["transcribe-vocabulary.txt", "translate-terminology.csv", "polly-readings.csv"]) {
    const d = makeDict(GOOD);
    build(["generate", "--dir", d]);
    writeFileSync(join(d, f), read(d, f).replace("HLS", "HLSX"));
    const r = build(["generate", "--check", "--dir", d]);
    assert.equal(r.status, 1, f);
    assert.match(r.err, new RegExp(`${f.replace(".", "\\.")}: differs from terms.csv, line \\d+`));
    cleanup(d);
  }
});
test("--check fails when a generated file is missing", () => {
  const d = makeDict(GOOD);
  const r = build(["generate", "--check", "--dir", d]);
  assert.equal(r.status, 1);
  assert.match(r.err, /polly-readings\.csv: missing/);
  cleanup(d);
});

test("missing flag fields give line-numbered errors", () => {
  const d = makeDict("A,,,,y,,,,,,,,\nB,,,,,y,,,,,,,\nC3,,,y,,,,,,,,,\n");
  const r = build(["generate", "--dir", d]);
  assert.equal(r.status, 1);
  assert.match(r.err, /terms\.csv:2: translate_en_ja=y needs ja/);
  assert.match(r.err, /terms\.csv:3: polly_ja=y needs reading/);
  cleanup(d);
});
test("a bad flag value, unknown column, comma in a field, and a digit phrase are all errors", () => {
  assert.throws(() => parseTerms(HEADER + "A,,,yes,,,,,,,,,\n"), /transcribe_en must be "y"/);
  assert.throws(() => parseTerms("en,bogus\nA,b\n"), /unknown column "bogus"/);
  assert.throws(() => parseTerms(HEADER + '"A, B",,,y,,,,,,,,,\n'), /contains a comma/);
  assert.throws(() => parseTerms(HEADER + "SigV4,,,y,,,,,,,,,\n"), /phrase required/);
});
test("reserved reverse-direction columns are ignored with a notice", () => {
  const { rows, notices } = parseTerms("en,transcribe_en,transcribe_ja,polly_en\nHLS,y,y,y\n");
  assert.equal(rows.length, 1);
  assert.equal(notices.length, 2);
  assert.equal(renderReadings(rows).split("\n").pop(), "");
});
test("duplicates: terminology is case-insensitive, Polly is exact, alias rows may repeat an en", () => {
  assert.throws(() => parseTerms(HEADER + "Foo,F,,,y,,,,,,,,\nfoo,F,,,y,,,,,,,,\n"), /duplicate terminology en/);
  assert.doesNotThrow(() => parseTerms(HEADER + "Foo,,エフ,,,y,,,,,,,\nfoo,,エフ,,,y,,,,,,,\n"));
  assert.throws(() => parseTerms(HEADER + "Foo,,エフ,,,y,,,,,,,\nFoo,,エフ,,,y,,,,,,,\n"), /duplicate en "Foo"/);
  assert.doesNotThrow(() => parseTerms(HEADER + "Foo,,,y,,,,,,,,,\nFoo,,,y,,,foo-two,,,,,,\n"));
});
test("ordering: position numbers first, then file order for the rest", () => {
  const { rows } = parseTerms(HEADER + "A,,,y,,,,,,,3,,\nB,,,y,,,,,,,,,\nC,,,y,,,,,,,1,,\nD,,,y,,,,,,,3,,\n");
  const order = renderVocabulary(rows).split("\n").slice(1, 5).map((l) => l.split("\t")[3]);
  assert.deepEqual(order, ["C", "A", "D", "B"]);
});
test("the three outputs may order the same rows differently", () => {
  const { rows } = parseTerms(HEADER + "A,a,,,y,,,,,,,2,\nB,b,,,y,,,,,,,1,\n");
  assert.equal(renderTerminology(rows), "en,ja\nB,b\nA,a\n");
});
test("whitespace is normalized", () => {
  const { rows } = parseTerms(HEADER + "  Media   Live ,x,,y,,,,,,,,,\n");
  assert.equal(rows[0].en, "Media Live");
});
test("invalid output never replaces existing good files", () => {
  const d = makeDict(GOOD);
  assert.equal(build(["generate", "--dir", d]).status, 0);
  const before = read(d, "polly-readings.csv");
  // reading with Latin letters passes terms.csv parsing but fails validate.mjs
  writeFileSync(join(d, "terms.csv"), HEADER + "HLS,HLS,abc,y,y,y,,,,,,,\n");
  const r = build(["generate", "--dir", d]);
  assert.equal(r.status, 1);
  assert.match(r.err, /generated .*contains Latin letters/);
  assert.equal(read(d, "polly-readings.csv"), before);
  assert.ok(!existsSync(join(d, ".polly-readings.csv.tmp")));
  cleanup(d);
});

test("product names are never respelled; only the Polly alias differs", () => {
  const body = [
    "AWS Elemental MediaPackage,AWS Elemental MediaPackage,AWS エレメンタル メディアパッケージ,y,y,y,,,,,,,",
    "channel,チャンネル,,,y,,,,,,,,",
  ].join("\n") + "\n";
  const d = makeDict(body);
  assert.equal(build(["generate", "--dir", d]).status, 0);
  const name = "AWS Elemental MediaPackage";
  const vocab = parseCsv(read(d, "transcribe-vocabulary.txt").replace(/\t/g, "|")).map((r) => r.cells[0].split("|"));
  assert.equal(vocab[1][3], name);
  const terms = parseCsv(read(d, "translate-terminology.csv"));
  assert.equal(terms[1].cells[0], name);
  assert.equal(terms[1].cells[1], name);
  const polly = read(d, "polly-readings.csv").split("\n").filter((l) => !l.startsWith("#"));
  assert.equal(polly[1], `${name},AWS エレメンタル メディアパッケージ`);
  const reading = "エレメンタル";
  assert.ok(!read(d, "transcribe-vocabulary.txt").includes(reading));
  assert.ok(!read(d, "translate-terminology.csv").includes(reading));
  cleanup(d);
});

test("the committed example generates byte-identical files", () => {
  assert.equal(build(["generate", "--check", "--dir", join(import.meta.dirname, "..", "example")]).status, 0);
});

test("init copies the example into a local folder, or starts empty, and refuses to overwrite", () => {
  for (const empty of [false, true]) {
    const root = tmp("dict-init-");
    mkdirSync(join(root, "dictionaries", "example"), { recursive: true });
    writeFileSync(join(root, "dictionaries", "example", "terms.csv"), HEADER + GOOD);
    const r = build(["init", "--root", root, ...(empty ? ["--empty"] : [])]);
    assert.equal(r.status, 0, r.all);
    const local = join(root, "dictionaries", "local");
    assert.equal(read(local, "terms.csv"), empty ? HEADER : HEADER + GOOD);
    assert.ok(existsSync(join(local, "polly-readings.csv")));
    assert.equal(build(["init", "--root", root]).status, 1);
    cleanup(root);
  }
});
