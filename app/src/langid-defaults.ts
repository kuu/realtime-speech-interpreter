// Dynamic language-ID settle defaults, shared by config.ts and language-gate.ts (no imports: config.ts must stay
// free of modules that depend on it).
export const LANGID_SETTLE_WORDS_DEFAULT = 3;
export const LANGID_SETTLE_WORDS_AFTER_JA = 5;
export const LANGID_JA_MEMORY_MS = 60000;
// Settle thresholds for a ja-JP source lane, in stable items (punctuation excluded). They mirror the English values
// above: fixed mode uses LANGID_SETTLE_ITEMS, dynamic mode the default or, within LANGID_JA_MEMORY_MS after a
// non-source (English) result, the after-English value. JA_SETTLE_ITEMS in language-gate.ts (3) is the as-said path's own.
export const LANGID_SETTLE_ITEMS = 5;
export const LANGID_SETTLE_ITEMS_DEFAULT = 3;
export const LANGID_SETTLE_ITEMS_AFTER_EN = 5;
