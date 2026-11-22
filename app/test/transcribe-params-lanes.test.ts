// Transcribe request with one vocabulary per lane (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeParams } from "../src/transcribe-params.js";

const base = { languageCode: "en-US", partialResultsStability: "high" };
const langid = { mode: "langid" as const, options: ["en-US", "ja-JP"] };

test("one lane: the request is exactly today's (a string name)", () => {
  const p = transcribeParams({ ...base, vocabularyName: "voc-en" }, 16000, langid);
  assert.equal(p.VocabularyNames, "voc-en");
  assert.equal(p.PreferredLanguage, "en-US");
  const none = transcribeParams({ ...base, vocabularyName: "" }, 16000, langid);
  assert.equal("VocabularyNames" in none, false);
});
test("a list with one name equals the string form", () => {
  assert.deepEqual(
    transcribeParams({ ...base, vocabularyName: ["voc-en"] }, 16000, langid),
    transcribeParams({ ...base, vocabularyName: "voc-en" }, 16000, langid),
  );
});
test("two lanes: comma list in lane order, empty names skipped", () => {
  assert.equal(transcribeParams({ ...base, vocabularyName: ["voc-en", "voc-en-ja"] }, 16000, langid).VocabularyNames, "voc-en,voc-en-ja");
  assert.equal(transcribeParams({ ...base, vocabularyName: ["", "voc-en-ja"] }, 16000, langid).VocabularyNames, "voc-en-ja");
  assert.equal("VocabularyNames" in transcribeParams({ ...base, vocabularyName: ["", ""] }, 16000, langid), false);
});
test("single-language mode (filter off) takes one name", () => {
  const p = transcribeParams({ ...base, vocabularyName: "voc-en" }, 16000, { mode: "off", options: [] });
  assert.equal(p.VocabularyName, "voc-en");
  assert.equal(p.LanguageCode, "en-US");
});
