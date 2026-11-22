// terms.csv: the single source file the three dictionaries are generated from.
// Format and rules: docs/dictionaries.md. No dependencies.
import { parseCsv, serializeCsv } from "./csv.mjs";

export const COLUMNS = [
  "en",
  "ja",
  "reading",
  "transcribe_en",
  "translate_en_ja",
  "polly_ja",
  "phrase",
  "display_as",
  "notes",
  "source",
  "transcribe_en_pos",
  "translate_en_ja_pos",
  "polly_ja_pos",
];
// The reverse direction (Japanese speech to English, issue #9). Optional columns: an existing terms.csv without them is
// valid unchanged, and TERMS_HEADER (the header of a new terms.csv) stays as it was.
export const REVERSE_COLUMNS = [
  "transcribe_ja",
  "translate_ja_en",
  "polly_en",
  "reading_en",
  "phrase_ja",
  "ja_variants",
  "transcribe_ja_pos",
  "translate_ja_en_pos",
  "polly_en_pos",
];
// No column is reserved any more: the three flags above are used. Kept as an empty list for importers.
export const RESERVED_COLUMNS = [];
const FLAGS = ["transcribe_en", "translate_en_ja", "polly_ja"];
const RFLAGS = ["transcribe_ja", "translate_ja_en", "polly_en"];
// Flags that also accept "n" (an explicit opt-out of a derived default): transcribe_ja and translate_ja_en.
const OPT_OUT = ["transcribe_ja", "translate_ja_en"];
const POS = ["transcribe_en_pos", "translate_en_ja_pos", "polly_ja_pos", "transcribe_ja_pos", "translate_ja_en_pos", "polly_en_pos"];
const TEXT_FIELDS = ["en", "ja", "reading", "phrase", "display_as", "reading_en", "phrase_ja"];
const KATAKANA = /[\u30a0-\u30ff]/;
const nfkc = (s) => s.normalize("NFKC");
// One word of a ja-JP Transcribe Phrase: hiragana, katakana, kanji, 々 and the long-vowel mark (validate.mjs checks the same set).
export const JA_PHRASE_WORD = /^[\u3041-\u3096\u30a1-\u30fa\u30fc\u3005\u3400-\u4dbf\u4e00-\u9fff]+$/u;

export class TermsError extends Error {
  constructor(errors) {
    super(errors.join("\n"));
    this.errors = errors;
  }
}

export const POLLY_HEADER_COMMENT = [
  "# Polly pronunciation readings: term,reading (UTF-8). Generated from terms.csv by node dictionaries/build.mjs; do not edit by hand.",
  '# The app wraps each exact, case-sensitive Latin-script term in SSML <sub alias="reading">term</sub> just before Amazon Polly.',
  '# Reading: katakana, long-vowel mark, spaces, digits only (no " < > &). Longest term wins.',
  "# Validate: node dictionaries/validate.mjs. Lines starting with # are comments; the header row term,reading comes first.",
];

const norm = (s) => (s ?? "").trim().replace(/ {2,}/g, " ");

/** Phrase for Transcribe, derived from the display form. Throws if it cannot be derived. */
export function derivePhrase(display) {
  const tokens = norm(display).split(" ").filter(Boolean);
  if (tokens.length === 0) throw new Error("empty display form");
  const out = tokens.map((t) => {
    if (/^[A-Z]{2,6}$/.test(t)) return t.split("").join(".") + ".";
    if (/^[A-Za-z']+$/.test(t)) return t.replace(/([a-z])([A-Z])/g, "$1-$2");
    throw new Error(`phrase required: "${t}" has digits or other characters (spell numbers out)`);
  });
  return out.join("-");
}

/** Parse and validate terms.csv text. Returns { rows, notices }. Throws TermsError listing every problem. */
export function parseTerms(text, label = "terms.csv") {
  let table;
  try {
    table = parseCsv(text);
  } catch (e) {
    throw new TermsError([`${label}: ${e.message}`]);
  }
  const notices = [];
  const errors = [];
  if (table.length === 0) throw new TermsError([`${label}:1: file is empty (needs a header row)`]);
  const header = table[0].cells.map((c) => c.trim());
  const known = new Set([...COLUMNS, ...REVERSE_COLUMNS]);
  header.forEach((h) => {
    if (RESERVED_COLUMNS.includes(h)) notices.push(`column "${h}" is reserved for the reverse direction and is ignored`);
    else if (!known.has(h)) errors.push(`${label}:1: unknown column "${h}"`);
  });
  if (!header.includes("en")) errors.push(`${label}:1: missing required column "en"`);
  if (new Set(header).size !== header.length) errors.push(`${label}:1: duplicate column name`);
  if (errors.length) throw new TermsError(errors);

  const rows = [];
  for (const { line, cells } of table.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue;
    const err = (m) => errors.push(`${label}:${line}: ${m}`);
    if (cells.length > header.length) err(`${cells.length} cells but the header has ${header.length}`);
    const r = Object.fromEntries([...COLUMNS, ...REVERSE_COLUMNS].map((c) => [c, ""]));
    header.forEach((h, i) => {
      if (known.has(h)) r[h] = cells[i] ?? "";
    });
    for (const f of TEXT_FIELDS) {
      r[f] = norm(r[f]);
      if (/[,"\t\r\n]/.test(r[f])) err(`${f} "${r[f]}" contains a comma, quote, TAB or newline (the generated files cannot quote it)`);
    }
    r.notes = r.notes.trim();
    r.source = r.source.trim();
    // ja_variants: other Japanese spellings, separated by "|"; each is a text field of its own.
    r.ja_variants = r.ja_variants
      .split("|")
      .map(norm)
      .filter((v) => v !== "");
    for (const v of r.ja_variants) {
      if (/[,"\t\r\n]/.test(v)) err(`ja_variants entry "${v}" contains a comma, quote, TAB or newline (the generated files cannot quote it)`);
    }
    for (const f of [...FLAGS, ...RFLAGS]) {
      const v = r[f].trim().toLowerCase();
      if (v !== "" && v !== "y" && !(v === "n" && OPT_OUT.includes(f))) {
        err(`${f} must be ${OPT_OUT.includes(f) ? '"y", "n"' : '"y"'} or empty, got "${r[f]}"`);
      }
      r[f] = v;
    }
    for (const p of POS) {
      const v = r[p].trim();
      if (v !== "" && !/^\d+$/.test(v)) err(`${p} must be a whole number or empty, got "${v}"`);
      r[p] = v === "" ? null : Number(v);
    }
    if (r.en === "") err("en is empty");
    if (r.translate_en_ja === "y" && r.ja === "") err(`translate_en_ja=y needs ja ("${r.en}")`);
    if (r.polly_ja === "y" && r.reading === "") err(`polly_ja=y needs reading ("${r.en}")`);
    // Reverse direction.
    if (r.translate_ja_en === "y" && r.ja === "" && r.reading === "" && r.ja_variants.length === 0) {
      err(`translate_ja_en=y needs ja, reading or ja_variants ("${r.en}")`);
    }
    if (r.polly_en === "y") {
      if (r.reading_en === "") err(`polly_en=y needs reading_en ("${r.en}")`);
      else if (KATAKANA.test(r.reading_en) || /[\u3040-\u309f\u3400-\u9fff]/u.test(r.reading_en)) {
        err(`reading_en "${r.reading_en}" contains Japanese characters; the English voice needs an English-letter alias ("${r.en}")`);
      }
    }
    if (r.transcribe_ja === "y" && r.phrase_ja === "" && r.reading === "") {
      err(`transcribe_ja=y needs phrase_ja or reading ("${r.en}")`);
    }
    r._line = line;
    r._index = rows.length;
    // The Japanese vocabulary needs no flag: a row with a reading (or phrase_ja) is in it unless transcribe_ja=n.
    r._vocab_ja = r.transcribe_ja !== "n" && (r.phrase_ja !== "" || r.reading !== "") ? "y" : "";
    r._phrase_ja = r.phrase_ja || r.reading.replace(/ /g, "-");
    r._display = r.display_as || r.en;
    if (r.transcribe_en === "y" && r.en !== "") {
      try {
        r._phrase = r.phrase || derivePhrase(r._display);
      } catch (e) {
        err(e.message);
      }
    }
    rows.push(r);
  }

  // Alias rows: a later row with the same en may only add a Transcribe phrase.
  const firstByEn = new Map();
  for (const r of rows) {
    if (!firstByEn.has(r.en)) {
      firstByEn.set(r.en, r);
      continue;
    }
    const noOthers = (...fs) => fs.every((f) => !r[f]);
    // Existing form: an extra Transcribe phrase (empty ja and reading). New form: an extra Japanese spelling of the same
    // en (ja filled, translate_ja_en=y, nothing else). Neither adds a Japanese vocabulary row of its own.
    const aliasOnly =
      (r.transcribe_en === "y" && noOthers("translate_en_ja", "polly_ja", "ja", "reading", "transcribe_ja", "translate_ja_en", "polly_en")) ||
      (r.translate_ja_en === "y" && r.ja !== "" && noOthers("transcribe_en", "translate_en_ja", "polly_ja", "transcribe_ja", "polly_en", "reading"));
    if (!aliasOnly) {
      errors.push(
        `${label}:${r._line}: duplicate en "${r.en}" (first on line ${firstByEn.get(r.en)._line}); only alias rows (transcribe_en=y, no ja, no reading) may repeat an en`,
      );
    }
  }
  const dup = (flag, keyOf, label, ci) => {
    const seen = new Map();
    for (const r of rows) {
      if (r[flag] !== "y" || !r.en) continue;
      const k = keyOf(r);
      if (k === undefined) continue;
      const key = ci ? k.toLowerCase() : k;
      if (seen.has(key)) errors.push(`${label}:${r._line}: duplicate ${label} "${k}" (first on line ${seen.get(key)})`);
      else seen.set(key, r._line);
    }
  };
  dup("transcribe_en", (r) => r._phrase, "Transcribe phrase (case-insensitive)", true);
  dup("translate_en_ja", (r) => r.en, "terminology en (case-insensitive)", true);
  dup("polly_ja", (r) => r.en, "Polly term", false);
  // Reverse direction. Japanese phrase of the vocabulary: unique. English alias: one row per English term.
  // An explicit phrase_ja is checked like any other phrase; a phrase derived from a reading is skipped with a warning instead.
  dup("_vocab_ja", (r) => r.phrase_ja || undefined, "Transcribe ja-JP phrase", false);
  dup("polly_en", (r) => r.en, "Polly English term", false);
  if (errors.length) throw new TermsError(errors);
  const warnings = [...terminologyWarnings(rows), ...vocabularyJaWarnings(rows)];
  return { rows, notices, warnings };
}

/** Warnings about the single multi-directional terminology (translate_en_ja rows; both lanes read it). */
export function terminologyWarnings(rows) {
  const warnings = [];
  const written = ordered(rows, "translate_en_ja", "translate_en_ja_pos");
  // Several English terms for one Japanese term: the reverse direction uses one of them.
  const byJa = new Map();
  for (const r of written) {
    const key = nfkc(r.ja).toLowerCase();
    if (!byJa.has(key)) byJa.set(key, []);
    byJa.get(key).push(r);
  }
  const ambiguous = [...byJa.values()].filter((g) => g.length > 1);
  if (ambiguous.length) {
    const parts = ambiguous.map((group) => {
      const use = preferredReverse(group);
      return `"${group[0].ja}": ${group.map((r) => `"${r.en}" (line ${r._line})`).join(", ")} -> ja to en uses "${use.en}"`;
    });
    warnings.push(
      `${ambiguous.length} Japanese term(s) have several English terms; the reverse direction (ja to en) uses the row with display_as, ` +
        `else the first in file order: ${parts.join("; ")}.`,
    );
  }
  // A multi-directional terminology cannot exclude a row from one direction.
  const noReverse = written.filter((r) => r.translate_ja_en === "n");
  if (noReverse.length) {
    warnings.push(
      `translate_ja_en=n on ${noReverse.map((r) => `"${r.en}" (line ${r._line})`).join(", ")}: the terminology is multi-directional, ` +
        "so these rows are still used in the ja to en direction (one file cannot exclude a row from one direction).",
    );
  }
  // Rows only wanted in reverse are not written (no en to ja entry means no terminology row).
  const reverseOnly = rows.filter((r) => r.translate_ja_en === "y" && r.translate_en_ja !== "y");
  if (reverseOnly.length) {
    warnings.push(
      `translate_ja_en=y without translate_en_ja=y is ignored (the terminology has no reverse-only rows): ${reverseOnly.map((r) => `"${r.en}" (line ${r._line})`).join(", ")}.`,
    );
  }
  return warnings;
}
/**
 * Rows derived from a reading that cannot be a ja-JP Phrase (digits, Latin letters, middle dot) or repeat an earlier Phrase are
 * left out of the Japanese vocabulary (sets r._vocab_ja to ""); one warning lists them. Explicit phrase_ja is never touched here.
 */
function vocabularyJaWarnings(rows) {
  const warnings = [];
  const seen = new Set(rows.filter((r) => r._vocab_ja === "y" && r.phrase_ja).map((r) => r.phrase_ja));
  const bad = [];
  const dupes = [];
  for (const r of rows) {
    if (r._vocab_ja !== "y" || r.phrase_ja) continue;
    if (!r._phrase_ja.split("-").every((w) => JA_PHRASE_WORD.test(w))) {
      r._vocab_ja = "";
      bad.push(`"${r.en}" (line ${r._line})`);
    } else if (seen.has(r._phrase_ja)) {
      r._vocab_ja = "";
      dupes.push(`"${r.en}" (line ${r._line})`);
    } else seen.add(r._phrase_ja);
  }
  if (bad.length) {
    warnings.push(
      `${bad.length} row(s) are not in transcribe-vocabulary-ja.txt because their reading is not a valid ja-JP Phrase (hiragana, katakana, kanji, ー only; no digits or Latin letters): ${bad.join(", ")}. Set phrase_ja on them, or transcribe_ja=n to silence this.`,
    );
  }
  if (dupes.length) {
    warnings.push(
      `${dupes.length} row(s) are not in transcribe-vocabulary-ja.txt because an earlier row has the same Phrase: ${dupes.join(", ")}. Set phrase_ja on them, or transcribe_ja=n to silence this.`,
    );
  }
  return warnings;
}
/** Of several rows with the same Japanese term: the one the reverse direction uses (display_as set, else the first). */
function preferredReverse(group) {
  return group.find((r) => r.display_as) ?? group[0];
}

/** Rows with a flag, ordered: rows with a position number first (numeric, ties by file order), then the rest in file order. */
export function ordered(rows, flag, posCol) {
  return rows
    .filter((r) => r[flag] === "y")
    .sort((a, b) => {
      const pa = a[posCol];
      const pb = b[posCol];
      if (pa !== null && pb !== null) return pa - pb || a._index - b._index;
      if (pa !== null) return -1;
      if (pb !== null) return 1;
      return a._index - b._index;
    });
}

export function renderVocabulary(rows) {
  const lines = ["Phrase\tSoundsLike\tIPA\tDisplayAs"];
  for (const r of ordered(rows, "transcribe_en", "transcribe_en_pos")) lines.push(`${r._phrase}\t\t\t${r._display}`);
  return lines.join("\n") + "\n";
}

/**
 * The one multi-directional Translate terminology (header en,ja) used by both lanes. The rows are the translate_en_ja rows
 * in today's order. Only when several English terms share one Japanese term, the row the reverse direction should use
 * (display_as set, else the first) is moved to the front of that group, so a reader that takes the first row per Japanese
 * term gets the intended one; the set of entries never changes.
 */
export function renderTerminology(rows) {
  const rs = ordered(rows, "translate_en_ja", "translate_en_ja_pos");
  const groups = new Map();
  for (const r of rs) {
    const key = nfkc(r.ja).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [["en", "ja"]];
  const done = new Set();
  for (const r of rs) {
    const key = nfkc(r.ja).toLowerCase();
    const group = groups.get(key);
    if (group.length < 2 || !group.some((g) => g.display_as)) {
      out.push([r.en, r.ja]);
      continue;
    }
    if (done.has(r)) continue;
    // Group with a preferred row: the preferred row takes the first slot, the others keep their order after it.
    if (r === group[0]) {
      const use = preferredReverse(group);
      for (const g of [use, ...group.filter((x) => x !== use)]) {
        out.push([g.en, g.ja]);
        done.add(g);
      }
    }
  }
  return serializeCsv(out);
}

export function renderReadings(rows) {
  const lines = [...POLLY_HEADER_COMMENT, "term,reading"];
  for (const r of ordered(rows, "polly_ja", "polly_ja_pos")) lines.push(`${r.en},${r.reading}`);
  return lines.join("\n") + "\n";
}

export const OUTPUT_FILES = {
  "transcribe-vocabulary.txt": renderVocabulary,
  "translate-terminology.csv": renderTerminology,
  "polly-readings.csv": renderReadings,
};

/** Header line of terms.csv. */
export const TERMS_HEADER = COLUMNS.join(",") + "\n";

// ---- reverse direction: generated only when at least one row has the flag (render returns null otherwise) ----
/** Rows of the Japanese Transcribe vocabulary: every row with a reading (or phrase_ja), unless transcribe_ja=n. */
export function vocabularyJaRows(rows) {
  return ordered(rows, "_vocab_ja", "transcribe_ja_pos");
}
export function renderVocabularyJa(rows) {
  const rs = vocabularyJaRows(rows);
  if (rs.length === 0) return null;
  const lines = ["Phrase\tSoundsLike\tIPA\tDisplayAs"];
  for (const r of rs) lines.push(`${r._phrase_ja}\t\t\t${r.en}`);
  return lines.join("\n") + "\n";
}
export const POLLY_EN_HEADER_COMMENT = [
  "# Polly pronunciation readings for the English voice: term,reading (UTF-8). Generated from terms.csv by node dictionaries/build.mjs; do not edit by hand.",
  '# The app wraps each exact, case-sensitive Latin-script term in SSML <sub alias="reading">term</sub> just before Amazon Polly.',
  "# Reading: English letters, spaces, hyphens and digits only (no Japanese characters, no \" < > &). Longest term wins.",
  "# Validate: node dictionaries/validate.mjs. Lines starting with # are comments; the header row term,reading comes first.",
];
export function renderReadingsEn(rows) {
  const rs = ordered(rows, "polly_en", "polly_en_pos");
  if (rs.length === 0) return null;
  const lines = [...POLLY_EN_HEADER_COMMENT, "term,reading"];
  for (const r of rs) lines.push(`${r.en},${r.reading_en}`);
  return lines.join("\n") + "\n";
}
/** Files of the reverse direction. Each renderer returns null when no row has its flag: the file is then not written. */
export const OPTIONAL_OUTPUT_FILES = {
  "transcribe-vocabulary-ja.txt": renderVocabularyJa,
  "polly-readings-en.csv": renderReadingsEn,
};
