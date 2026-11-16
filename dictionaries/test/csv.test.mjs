import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, serializeCsv } from "../lib/csv.mjs";

test("parses plain rows with line numbers", () => {
  const rows = parseCsv("a,b\nc,d\n");
  assert.deepEqual(rows.map((r) => r.cells), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(rows.map((r) => r.line), [1, 2]);
});
test("quoted fields: commas, doubled quotes and newlines", () => {
  const rows = parseCsv('a,"b, ""c""",d\n"x\ny",z\n');
  assert.deepEqual(rows[0].cells, ["a", 'b, "c"', "d"]);
  assert.deepEqual(rows[1].cells, ["x\ny", "z"]);
  assert.equal(rows[1].line, 2);
});
test("CRLF and a missing final newline", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d").map((r) => r.cells), [["a", "b"], ["c", "d"]]);
});
test("a UTF-8 BOM is ignored", () => {
  assert.deepEqual(parseCsv("\uFEFFen,ja\nx,y\n")[0].cells, ["en", "ja"]);
});
test("Japanese text round-trips", () => {
  const rows = [["en", "ja"], ["MediaPackage", "メディアパッケージ"], ["a,b", 'say "hi"']];
  const text = serializeCsv(rows);
  assert.equal(text, 'en,ja\nMediaPackage,メディアパッケージ\n"a,b","say ""hi"""\n');
  assert.deepEqual(parseCsv(text).map((r) => r.cells), rows);
});
test("an unterminated quote throws with a line number", () => {
  assert.throws(() => parseCsv('a,"b\n'), /line 1: unterminated/);
});
test("text after a closing quote throws", () => {
  assert.throws(() => parseCsv('"a"b,c\n'), /after closing quote/);
});
