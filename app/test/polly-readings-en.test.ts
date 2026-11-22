import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadings, loadReadingsEn, parseReadingsEn } from "../src/polly-readings.js";

test("an English alias without Japanese characters is accepted and wrapped in <sub>", () => {
  const p = parseReadingsEn("term,reading\nSRT,ess are tee\nYamada,yah mah dah\n");
  assert.deepEqual(p.problems, []);
  const r = createReadings(p.entries);
  assert.equal(r.apply("We use SRT today.").inner, 'We use <sub alias="ess are tee">SRT</sub> today.');
});
test("an alias with katakana or kanji is rejected (katakana belongs to the Japanese voice)", () => {
  const p = parseReadingsEn("term,reading\nSRT,エスアールティー\nAWS,ay double-u ess\nYama,山\n");
  assert.deepEqual(p.entries.map((e) => e.term), ["AWS"]);
  assert.equal(p.problems.length, 2);
  assert.match(p.problems[0], /Japanese characters/);
});
test("loadReadingsEn: missing file = no readings and no warning; valid file loads; a katakana row warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "readings-en-"));
  const warn = mock.method(console, "error", () => {});
  const out = mock.method(console, "log", () => {});
  try {
    assert.equal(loadReadingsEn(join(dir, "missing.csv")), null);
    assert.equal(warn.mock.callCount(), 0);
    const f = join(dir, "r.csv");
    writeFileSync(f, "term,reading\nSRT,ess are tee\nBad,バッド\n");
    const r = loadReadingsEn(f);
    assert.ok(r);
    assert.equal(r.size, 1);
  } finally {
    warn.mock.restore();
    out.mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
