import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { validateDictionaryDir } from "../validate.mjs";
import { DICT } from "./helpers.mjs";

test("the example dictionaries validate with the committed entry counts", () => {
  const r = validateDictionaryDir(join(DICT, "example"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.counts.vocabulary.entries, 249);
  assert.equal(r.counts.terminology.entries, 393);
  assert.equal(r.counts.readings.entries, 82);
});
test("a missing directory reports errors instead of throwing", () => {
  const r = validateDictionaryDir("/nonexistent/dict-dir");
  assert.equal(r.errors.length, 3);
});
