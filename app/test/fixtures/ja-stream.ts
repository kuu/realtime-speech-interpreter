// Synthetic Japanese Transcribe results for the segmenter tests (no real speech).
import type { TxItem, TxResult } from "../../src/segmenter.js";

const PUNCT = /^[。、？！?!「」]$/;
export function jaItems(tokens: string[], stable: number = tokens.length, base = 0, conf?: number): TxItem[] {
  return tokens.map((c, i) => {
    const punct = PUNCT.test(c);
    return {
      Content: c,
      Type: punct ? "punctuation" : "pronunciation",
      Stable: i < stable,
      StartTime: base + i * 0.3,
      EndTime: base + i * 0.3 + 0.25,
      ...(conf !== undefined && !punct ? { Confidence: conf } : {}),
    };
  });
}
export function jaPartial(id: string, tokens: string[], stable: number = tokens.length, base = 0): TxResult {
  return { ResultId: id, IsPartial: true, LanguageCode: "ja-JP", Alternatives: [{ Items: jaItems(tokens, stable, base) }] };
}
export function jaFinal(id: string, tokens: string[], base = 0): TxResult {
  return { ResultId: id, IsPartial: false, LanguageCode: "ja-JP", StartTime: base, EndTime: base + tokens.length * 0.3, Alternatives: [{ Items: jaItems(tokens, 0, base, 0.9) }] };
}
// Seeded generator (mulberry32) so the property test is reproducible.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const WORDS = ["今日", "は", "新しい", "機能", "を", "紹介", "し", "ます", "これ", "が", "皆さん", "の", "仕事", "に", "役立つ", "と", "思い", "ので", "まず", "デモ"];
export const SEPS = ["。", "、", "？", "！"];
