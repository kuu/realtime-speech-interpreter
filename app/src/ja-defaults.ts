// Defaults of the Japanese segmenter (no imports: config.ts and segmenter-ja.ts both read them).
export const JA_DEFAULT_CLAUSE_ENDINGS: readonly string[] = [
  "ので", "のに", "けど", "けれど", "けれども", "ため", "ために", "ながら", "ところ", "ですが", "ますが", "ですから",
  "ますので", "ては", "ても", "して", "いて", "えて", "んで",
];
export const JA_DEFAULT_DANGLING_TOKENS: readonly string[] = [
  "は", "が", "を", "に", "で", "と", "の", "も", "へ", "や", "から", "より", "まで", "って", "て",
  "そして", "しかし", "また", "ただ", "なので",
];
// The two lists must not share an entry (exact equality): rule 3 and the dangling test would disagree.
export function jaListOverlap(endings: readonly string[], dangling: readonly string[]): string[] {
  const d = new Set(dangling);
  return endings.filter((e) => d.has(e));
}

