// The settle threshold table of docs/bilingual-channels.md: fixed and dynamic mode, en-US (words) and ja-JP (items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LanguageGate, type LanguageGateOptions } from "../src/language-gate.js";
import { langidSettleItemsConfig } from "../src/config.js";
import { Segmenter, type SegmenterOptions, type TxItem, type TxResult } from "../src/segmenter.js";

const SEG: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: [],
  mergeShort: false, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
function toItems(tokens: string[], stable: number): TxItem[] {
  return tokens.map((c, i) => ({ Content: c, Type: "pronunciation", Stable: i < stable, StartTime: i * 0.4, EndTime: i * 0.4 + 0.3 }));
}
function partial(lang: string, tokens: string[], stable: number): TxResult {
  return { ResultId: "r1", IsPartial: true, LanguageCode: lang, Alternatives: [{ Items: toItems(tokens, stable), Transcript: tokens.join(" ") }] } as TxResult;
}
// Smallest number of stable items (1..9) at which the lane forwards a partial to its segmenter.
function firstForwarded(opts: LanguageGateOptions, lang: string, tokens: string[], before?: TxResult): number | null {
  for (let n = 1; n <= tokens.length; n++) {
    let got = 0;
    const seg = new Segmenter(SEG, () => { got++; });
    const orig = seg.onResult.bind(seg);
    seg.onResult = (r, now) => { if ((r.Alternatives?.[0]?.Items ?? []).length > 0) got++; orig(r, now); };
    const gate = new LanguageGate(opts, seg, () => 0);
    if (before) gate.onResult(before, 1000);
    gate.onResult(partial(lang, tokens, n), 1100);
    if (got > 0) return n;
  }
  return null;
}
const EN = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const JA = ["今日", "は", "新しい", "機能", "を", "紹介", "し", "ます", "。"].slice(0, 8);
const base = { shortWords: 4, shortMinConf: 0.6 };
const otherLang = (lang: string, tokens: string[]) => partial(lang, tokens, tokens.length);

test("fixed, en-US: langidSettleWords words", () => {
  assert.equal(firstForwarded({ ...base, source: "en-US", settleWords: 5 }, "en-US", EN), 5);
});
test("dynamic, en-US: 3 words, 5 within the memory window after Japanese", () => {
  const o: LanguageGateOptions = { ...base, source: "en-US", settleWords: 5, settleMode: "dynamic" };
  assert.equal(firstForwarded(o, "en-US", EN), 3);
  assert.equal(firstForwarded(o, "en-US", EN, { ...otherLang("ja-JP", ["はい"]), ResultId: "r0" } as TxResult), 5);
});
test("fixed, ja-JP: langidSettleItems stable items (default 5)", () => {
  assert.equal(firstForwarded({ ...base, source: "ja-JP", settleWords: 5 }, "ja-JP", JA), 5);
  assert.equal(firstForwarded({ ...base, source: "ja-JP", settleWords: 5, settleItems: 4 }, "ja-JP", JA), 4);
});
test("dynamic, ja-JP: 3 items, 5 within the memory window after English", () => {
  const o: LanguageGateOptions = { ...base, source: "ja-JP", settleWords: 5, settleMode: "dynamic" };
  assert.equal(firstForwarded(o, "ja-JP", JA), 3);
  assert.equal(firstForwarded(o, "ja-JP", JA, { ...otherLang("en-US", ["hello"]), ResultId: "r0" } as TxResult), 5);
  assert.equal(firstForwarded({ ...o, settleItemsDefault: 2, settleItemsAfterEn: 6 }, "ja-JP", JA), 2);
});
test("langidSettleItemsConfig: defaults 5 / 3 / 5, valid values pass, invalid falls back with a WARN", () => {
  assert.deepEqual(langidSettleItemsConfig({}), { settleItems: 5, settleItemsDefault: 3, settleItemsAfterEn: 5 });
  assert.deepEqual(
    langidSettleItemsConfig({ LANGID_SETTLE_ITEMS: "6", LANGID_SETTLE_ITEMS_DEFAULT: "2", LANGID_SETTLE_ITEMS_AFTER_EN: "7" }),
    { settleItems: 6, settleItemsDefault: 2, settleItemsAfterEn: 7 },
  );
  const orig = console.error;
  const warns: string[] = [];
  console.error = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    assert.equal(langidSettleItemsConfig({ LANGID_SETTLE_ITEMS: "0" }).settleItems, 5);
  } finally {
    console.error = orig;
  }
  assert.equal(warns.length, 1);
});
