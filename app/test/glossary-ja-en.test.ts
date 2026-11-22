import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerminologyCsv, glossaryLines, loadDeployedGlossary } from "../src/glossary.js";

const CSV = "ja,en\r\nメディアライブ,MediaLive\r\nメディアパッケージ,MediaPackage\r\nＭｅｄｉａＬｉｖｅ,MediaLive Dup\r\nメディアライブ,Second\r\n\"山田, 太郎\",Taro Yamada\r\n";
test("ja-en: header ja,en skipped; entries are [ja, en]; duplicate Japanese key keeps the first row (NFKC)", () => {
  const e = parseTerminologyCsv(CSV, "ja-en");
  assert.deepEqual(e, [
    ["メディアライブ", "MediaLive"],
    ["メディアパッケージ", "MediaPackage"],
    ["ＭｅｄｉａＬｉｖｅ", "MediaLive Dup"],
    ["山田, 太郎", "Taro Yamada"],
  ]);
});
test("ja-en: prompt lines read `ja = en`", () => {
  assert.equal(glossaryLines(parseTerminologyCsv("ja,en\nメディアライブ,MediaLive\n", "ja-en")), "メディアライブ = MediaLive");
});
test("en-ja stays the default and is unchanged (header en,ja; first English row wins)", () => {
  assert.deepEqual(parseTerminologyCsv("en,ja\nlaunch,ローンチ\nLaunch,発売\n"), [["launch", "ローンチ"]]);
});
test("loadDeployedGlossary passes the direction to the parser", async () => {
  const client = { send: async () => ({ TerminologyDataLocation: { Location: "https://example.invalid/t.csv" } }) };
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => "ja,en\nメディアライブ,MediaLive\n" });
  const e = await loadDeployedGlossary(client, "t-ja-en", fetchFn, 1000, "ja-en");
  assert.deepEqual(e, [["メディアライブ", "MediaLive"]]);
});
