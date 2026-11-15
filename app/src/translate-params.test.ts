// Unit tests for the TranslateText request builder (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateParams } from "./translate-params.js";
import { translateFormality } from "./config.js";

const base = { source: "en", target: "ja", terminologyName: "", formality: "FORMAL" as "FORMAL" | "INFORMAL" | "off" };

test("FORMAL and INFORMAL set Settings.Formality", () => {
  assert.deepEqual(translateParams("hi", base).Settings, { Formality: "FORMAL" });
  assert.deepEqual(translateParams("hi", { ...base, formality: "INFORMAL" }).Settings, { Formality: "INFORMAL" });
});

test("off sends exactly the old request (no Settings key)", () => {
  const p = translateParams("hi", { ...base, formality: "off" });
  assert.equal("Settings" in p, false);
  assert.deepEqual(p, { Text: "hi", SourceLanguageCode: "en", TargetLanguageCode: "ja" });
  const t = translateParams("hi", { ...base, formality: "off", terminologyName: "term" });
  assert.deepEqual(t, { Text: "hi", SourceLanguageCode: "en", TargetLanguageCode: "ja", TerminologyNames: ["term"] });
});

test("terminology is kept alongside Settings; empty terminology omitted", () => {
  const p = translateParams("hi", { ...base, terminologyName: "term" });
  assert.deepEqual(p.TerminologyNames, ["term"]);
  assert.deepEqual(p.Settings, { Formality: "FORMAL" });
  assert.equal("TerminologyNames" in translateParams("hi", base), false);
});
test("env -> params: the formality read from the environment reaches Settings (FORMAL, INFORMAL, off)", () => {
  const p = (v: string) => translateParams("hi", { ...base, formality: translateFormality({ TRANSLATE_FORMALITY: v }) });
  assert.deepEqual(p("FORMAL").Settings, { Formality: "FORMAL" });
  assert.deepEqual(p("INFORMAL").Settings, { Formality: "INFORMAL" });
  assert.equal("Settings" in p("off"), false);
});
