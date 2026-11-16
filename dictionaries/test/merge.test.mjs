import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEADER, build, cleanup, makeDict } from "./helpers.mjs";

const PROPOSED =
  HEADER +
  [
    "StreamDeck,ストリームデッキ,ストリームデッキ,y,y,y,,,reviewed,announcement.md:12,,,",
    "HLS,HLS,エイチエルエス,y,y,y,,,already known,announcement.md:6,,,",
    ",,,,,,,,row with no en is dropped,,,,",
    "Okafor,,,y,,,,,,announcement.md:17,,,",
  ].join("\n") +
  "\n";
const KNOWN = "HLS,HLS,エイチエルエス,y,y,y,,,,,,,\n";

test("merge without a terminal and without --yes aborts and changes nothing", () => {
  const d = makeDict(KNOWN);
  writeFileSync(join(d, "terms.proposed.csv"), PROPOSED);
  const before = readFileSync(join(d, "terms.csv"));
  const r = build(["merge", "--dir", d], { input: "" });
  assert.equal(r.status, 1);
  assert.match(r.err, /Not merged: no terminal to confirm on/);
  assert.deepEqual(readFileSync(join(d, "terms.csv")), before);
  cleanup(d);
});
test("merge --yes appends new rows only, skipping known terms and rows without en", () => {
  const d = makeDict(KNOWN);
  writeFileSync(join(d, "terms.proposed.csv"), PROPOSED);
  const before = readFileSync(join(d, "terms.csv"), "utf8");
  const r = build(["merge", "--dir", d, "--yes"]);
  assert.equal(r.status, 0, r.all);
  const after = readFileSync(join(d, "terms.csv"), "utf8");
  assert.ok(after.startsWith(before), "existing rows are untouched");
  const added = after.slice(before.length).trimEnd().split("\n");
  assert.deepEqual(added, [
    "StreamDeck,ストリームデッキ,ストリームデッキ,y,y,y,,,reviewed,announcement.md:12,,,",
    "Okafor,,,y,,,,,,announcement.md:17,,,",
  ]);
  // the merged file generates cleanly
  assert.equal(build(["generate", "--dir", d]).status, 0);
  assert.match(readFileSync(join(d, "translate-terminology.csv"), "utf8"), /StreamDeck,ストリームデッキ/);
  cleanup(d);
});
test("a proposal that would break terms.csv is refused with line numbers and nothing is written", () => {
  const d = makeDict(KNOWN);
  writeFileSync(join(d, "terms.proposed.csv"), HEADER + "Foo,,,y,y,,,,,,,,\n");
  const before = readFileSync(join(d, "terms.csv"));
  const r = build(["merge", "--dir", d, "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /terms\.proposed\.csv:2: translate_en_ja=y needs ja/);
  assert.deepEqual(readFileSync(join(d, "terms.csv")), before);
  cleanup(d);
});
test("merge with no proposal explains what to do", () => {
  const d = makeDict(KNOWN);
  const r = build(["merge", "--dir", d, "--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.err, /Run suggest first/);
  cleanup(d);
});
test("running merge twice does not add rows twice", () => {
  const d = makeDict(KNOWN);
  writeFileSync(join(d, "terms.proposed.csv"), PROPOSED);
  build(["merge", "--dir", d, "--yes"]);
  const once = readFileSync(join(d, "terms.csv"), "utf8");
  const r = build(["merge", "--dir", d, "--yes"]);
  assert.match(r.out, /Nothing to merge/);
  assert.equal(readFileSync(join(d, "terms.csv"), "utf8"), once);
  cleanup(d);
});
