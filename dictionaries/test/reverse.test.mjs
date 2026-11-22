// Reverse direction (Japanese speech to English): columns, flags, generated files, validator rules (node:test).
// Synthetic data only: fixtures/reverse/terms.csv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONAL_OUTPUT_FILES, RESERVED_COLUMNS, parseTerms, renderTerminology, renderVocabularyJa, renderReadingsEn, TERMS_HEADER, COLUMNS, REVERSE_COLUMNS } from "../lib/terms.mjs";
import { validateDictionaryDir } from "../validate.mjs";
import { FIX, HERE, REPO, build, cleanup, makeDict, tmp } from "./helpers.mjs";

const REV_HEADER =
  "en,ja,reading,transcribe_en,translate_en_ja,polly_ja,phrase,display_as,notes,source,transcribe_en_pos,translate_en_ja_pos,polly_ja_pos," +
  "transcribe_ja,translate_ja_en,polly_en,reading_en,phrase_ja,ja_variants,transcribe_ja_pos,translate_ja_en_pos,polly_en_pos\n";
const rev = (body) => REV_HEADER + body;
// A row builder for the reverse columns only: en, ja, reading, then the nine reverse columns.
const row = (en, ja, reading, ...r) => `${en},${ja},${reading},,,,,,,,,,,${[...r, "", "", "", "", "", "", "", "", ""].slice(0, 9).join(",")}\n`;
const FIXTURE = join(FIX, "reverse", "terms.csv");
function reverseDir() {
  const d = tmp();
  copyFileSync(FIXTURE, join(d, "terms.csv"));
  return d;
}

test("the new columns are optional: TERMS_HEADER and the column lists are unchanged for today's files", () => {
  assert.equal(TERMS_HEADER.trim().split(",").length, 13);
  assert.deepEqual(RESERVED_COLUMNS, []);
  assert.deepEqual(REVERSE_COLUMNS, ["transcribe_ja", "translate_ja_en", "polly_en", "reading_en", "phrase_ja", "ja_variants", "transcribe_ja_pos", "translate_ja_en_pos", "polly_en_pos"]);
  assert.equal(COLUMNS.length, 13);
});
test("the fixture parses with no notice and every reverse column filled where used", () => {
  const { rows, notices } = parseTerms(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(notices, []);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0].ja_variants, ["メディアライヴ", "ＭｅｄｉａＬｉｖｅ"]);
});
test("generate writes the two reverse files and today's three, with the documented content", () => {
  const d = reverseDir();
  try {
    const r = build(["generate", "--dir", d]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /transcribe-vocabulary-ja\.txt: 3 entries/);
    assert.doesNotMatch(r.out, /ja-en/, "there is no second terminology file");
    assert.match(r.out, /WARN translate_ja_en=y without translate_en_ja=y is ignored .*"Hanako Sato" \(line 5\)/);
    assert.match(r.out, /polly-readings-en\.csv: 2 entries/);
    assert.equal(
      readFileSync(join(d, "transcribe-vocabulary-ja.txt"), "utf8"),
      "Phrase\tSoundsLike\tIPA\tDisplayAs\nえーだぶりゅーえす\t\t\tAWS\nメディアライブ\t\t\tMediaLive\nエスアールティー\t\t\tSRT\n",
      "Phrase = phrase_ja or reading, DisplayAs = en; transcribe_ja_pos=1 puts AWS first",
    );
    assert.equal(existsSync(join(d, "translate-terminology-ja-en.csv")), false);
    assert.equal(readFileSync(join(d, "translate-terminology.csv"), "utf8"), "en,ja\nMediaLive,MediaLive\nSRT,SRT\nAWS,AWS\n", "the one multi-directional terminology: translate_en_ja rows only");
    const en = readFileSync(join(d, "polly-readings-en.csv"), "utf8");
    assert.match(en, /\nterm,reading\nMediaLive,media live\nSRT,ess are tee\n$/);
    assert.equal(build(["generate", "--check", "--dir", d]).status, 0);
    // today's files are still generated, from the same rows
    assert.ok(existsSync(join(d, "transcribe-vocabulary.txt")));
    assert.ok(existsSync(join(d, "polly-readings.csv")));
  } finally {
    cleanup(d);
  }
});
test("no row has a reading or a reverse flag: no reverse file is rendered, written or left behind", () => {
  const d = makeDict("HLS,HLS,,y,y,,,,,,,,\n");
  try {
    const { rows } = parseTerms(readFileSync(join(d, "terms.csv"), "utf8"));
    for (const fn of Object.values(OPTIONAL_OUTPUT_FILES)) assert.equal(fn(rows), null);
    assert.equal(build(["generate", "--dir", d]).status, 0);
    assert.deepEqual(readdirSync(d).sort(), ["polly-readings.csv", "terms.csv", "transcribe-vocabulary.txt", "translate-terminology.csv"]);
  } finally {
    cleanup(d);
  }
});
test("removing the last flag removes the stale reverse file on generate; --check reports it before", () => {
  const d = reverseDir();
  try {
    assert.equal(build(["generate", "--dir", d]).status, 0);
    const csv = readFileSync(join(d, "terms.csv"), "utf8").replace(/,y,y,y,(media live|ess are tee),/g, ",,,,$1,");
    writeFileSync(join(d, "terms.csv"), csv);
    // polly_en is gone from both rows; the other flags remain
    const chk = build(["generate", "--check", "--dir", d]);
    assert.notEqual(chk.status, 0);
    assert.match(chk.err, /polly-readings-en\.csv: exists but terms\.csv has no rows for it/);
    assert.equal(build(["generate", "--dir", d]).status, 0);
    assert.equal(existsSync(join(d, "polly-readings-en.csv")), false);
  } finally {
    cleanup(d);
  }
});
test("the example dictionary: generate --check passes; a fresh generate writes today's three files plus the derived Japanese vocabulary", () => {
  const ex = join(REPO, "dictionaries", "example");
  assert.equal(build(["generate", "--check", "--dir", ex]).status, 0);
  const d = tmp();
  try {
    copyFileSync(join(ex, "terms.csv"), join(d, "terms.csv"));
    assert.equal(build(["generate", "--dir", d]).status, 0);
    assert.deepEqual(readdirSync(d).sort(), ["polly-readings.csv", "terms.csv", "transcribe-vocabulary-ja.txt", "transcribe-vocabulary.txt", "translate-terminology.csv"]);
    for (const f of ["polly-readings.csv", "transcribe-vocabulary-ja.txt", "transcribe-vocabulary.txt", "translate-terminology.csv"]) {
      assert.equal(readFileSync(join(d, f), "utf8"), readFileSync(join(ex, f), "utf8"), f);
    }
  } finally {
    cleanup(d);
  }
});

// ---- terms.csv rules ----
test("rules: a flag without its field is an error naming the row", () => {
  assert.throws(() => parseTerms(rev(row("A", "", "", "y"))), /transcribe_ja=y needs phrase_ja or reading \("A"\)/);
  assert.throws(() => parseTerms(rev(row("A", "", "", "", "", "y"))), /polly_en=y needs reading_en \("A"\)/);
  assert.throws(() => parseTerms(rev(row("A", "", "", "", "y"))), /translate_ja_en=y needs ja, reading or ja_variants \("A"\)/);
  assert.doesNotThrow(() => parseTerms(rev(row("A", "", "アー", "y"))), "transcribe_ja: the reading is the phrase");
  assert.doesNotThrow(() => parseTerms(rev(row("A", "えー", "", "", "y"))));
});
test("rules: reading_en must be English letters (no katakana, no kanji)", () => {
  const bad = (r) => () => parseTerms(rev(`A,,,,,,,,,,,,,,,y,${r},,,,,\n`));
  assert.throws(bad("エー"), /reading_en "エー" contains Japanese characters/);
  assert.throws(bad("山"), /contains Japanese characters/);
  assert.doesNotThrow(bad("ay"));
});
test("rules: ja_variants entries follow the field rules (no comma, quote, TAB)", () => {
  assert.throws(() => parseTerms(rev(`A,あ,,,,,,,,,,,,,y,,,,"x,y",,,\n`)), /ja_variants entry "x,y"/);
});
test("rules: an alias row repeats an en only in the two documented forms; transcribe_ja on an alias row is an error", () => {
  assert.doesNotThrow(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "い", "", "", "y"))));
  assert.throws(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "い", "", "", "y", "y", "ay"))), /duplicate en "A"/);
  assert.throws(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "", "", "y"))), /duplicate en "A"/);
});
test("rules: an explicit phrase_ja must be unique; a phrase derived from a reading that repeats is skipped with a warning", () => {
  const phrase = (en, p) => `${en},,,,,,,,,,,,,,,,,${p},,,,\n`;
  assert.throws(() => parseTerms(rev(phrase("A", "あー") + phrase("B", "あー"))), /duplicate Transcribe ja-JP phrase "あー"/);
  const { rows, warnings } = parseTerms(rev(row("A", "", "アー") + row("B", "", "アー")));
  assert.deepEqual(vocabularyJaLines(rows), ["アー\t\t\tA"]);
  assert.ok(warnings.some((w) => /not in transcribe-vocabulary-ja\.txt because an earlier row has the same Phrase: "B" \(line 3\)/.test(w)));
});
// ---- validator: accept and reject ----
function dirWith(files) {
  const d = tmp();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  // today's three files so only the reverse ones are under test
  copyFileSync(join(REPO, "dictionaries", "example", "transcribe-vocabulary.txt"), join(d, "transcribe-vocabulary.txt"));
  copyFileSync(join(REPO, "dictionaries", "example", "translate-terminology.csv"), join(d, "translate-terminology.csv"));
  copyFileSync(join(REPO, "dictionaries", "example", "polly-readings.csv"), join(d, "polly-readings.csv"));
  return d;
}
const VH = "Phrase\tSoundsLike\tIPA\tDisplayAs\n";
function vocabErrors(body) {
  const d = dirWith({ "transcribe-vocabulary-ja.txt": VH + body });
  try {
    return validateDictionaryDir(d);
  } finally {
    cleanup(d);
  }
}
test("validator ja-JP vocabulary: accepted phrases (hiragana, katakana, kanji, 々, ー, hyphen-joined words)", () => {
  const r = vocabErrors("メディアライブ\t\t\tメディアライブ\nえーだぶりゅーえす\t\t\tＡＷＳ\n人々\t\t\t人々\nメディア-ライブ\t\t\t\n");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.counts.vocabularyJa.entries, 4);
});
test("validator ja-JP vocabulary: rejected phrases and columns", () => {
  const bad = (body, re) => {
    const r = vocabErrors(body);
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(body)} -> ${r.errors.join(" | ")}`);
  };
  bad("MediaLive\t\t\tMediaLive\n", /Phrase "MediaLive" has characters outside hiragana/);
  bad("メディア ライブ\t\t\tx\n", /contains a space/);
  bad("メディア2\t\t\tx\n", /characters outside/);
  bad("-メディア\t\t\tx\n", /leading, trailing or repeated hyphen/);
  bad("メディア--ライブ\t\t\tx\n", /leading, trailing or repeated hyphen/);
  bad("メディア\t\t\tx\nメディア\t\t\ty\n", /duplicate Phrase/);
  bad("メディア\tソレ\t\tx\n", /SoundsLike and IPA must be empty/);
  bad("\t\t\tx\n", /Phrase is empty/);
  bad("メディア\t\tx\n", /expected 4 TAB-separated columns/);
  bad("メディア\t\t\tx\n\n", /blank line/);
});
test("validator ja-JP vocabulary: header and BOM", () => {
  const d = dirWith({ "transcribe-vocabulary-ja.txt": "\uFEFFPhrase,DisplayAs\nあ\tい\n" });
  try {
    const r = validateDictionaryDir(d);
    assert.ok(r.errors.some((e) => /BOM/.test(e)));
    assert.ok(r.errors.some((e) => /header must be/.test(e)));
  } finally {
    cleanup(d);
  }
});
test("validator ja-JP vocabulary: a Latin DisplayAs is a warning (the documented DisplayAs set has no half-width Latin)", () => {
  const r = vocabErrors("メディアライブ\t\t\tMediaLive\nエスアールティー\t\t\tSRT\n");
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /2 row\(s\) have a DisplayAs outside hiragana, katakana, kanji and full-width capital letters/);
  assert.match(r.warnings[0], /create-vocabulary test/);
});
test("validator polly-readings-en: English alias accepted; katakana, symbols and duplicates rejected", () => {
  const run = (text) => {
    const d = dirWith({ "polly-readings-en.csv": text });
    try {
      return validateDictionaryDir(d);
    } finally {
      cleanup(d);
    }
  };
  const ok = run("# c\nterm,reading\nSRT,ess are tee\nMediaLive,media live\n");
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.counts.readingsEn.entries, 2);
  assert.ok(run("term,reading\nSRT,エスアールティー\n").errors.some((e) => /contains Japanese characters/.test(e)));
  assert.ok(run("term,reading\nSRT,ess <are> tee\n").errors.some((e) => /outside English letters/.test(e)));
  assert.ok(run("term,reading\nSRT,a\nSRT,b\n").errors.some((e) => /duplicate term "SRT"/.test(e)));
  assert.ok(run("term,reading\nSRT,\n").errors.some((e) => /empty/.test(e)));
  assert.ok(run("terms,reading\nSRT,a\n").errors.some((e) => /header must be exactly "term,reading"/.test(e)));
});
test("the generated reverse files of the fixture pass the validator (with the documented DisplayAs warning)", () => {
  const d = reverseDir();
  try {
    assert.equal(build(["generate", "--dir", d]).status, 0);
    const r = validateDictionaryDir(d);
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /DisplayAs/);
  } finally {
    cleanup(d);
  }
});

// ---- one multi-directional terminology (both lanes) ----
const vocabularyJaLines = (rows) => renderVocabularyJa(rows).trim().split("\n").slice(1);
// en,ja,reading,transcribe_en,translate_en_ja,polly_ja,phrase,display_as,... (13 columns) then the nine reverse columns
const term = (en, ja, { reading = "", display = "", ja_en = "", pos = "" } = {}) =>
  `${en},${ja},${reading},,y,,,${display},,,,${pos},,,${ja_en},,,,,,,\n`;
test("terminology: the file is the translate_en_ja rows in today's order, header en,ja", () => {
  const { rows } = parseTerms(rev(term("Zed", "ゼッド") + term("Alpha", "アルファ", { pos: "1" }) + term("Beta", "ベータ")));
  assert.equal(renderTerminology(rows), "en,ja\nAlpha,アルファ\nZed,ゼッド\nBeta,ベータ\n");
});
test("terminology: several English terms for one Japanese term warn, name the row the reverse direction uses, and keep every entry", () => {
  const first = parseTerms(rev(term("channel", "チャンネル") + term("channels", "チャンネル") + term("other", "その他")));
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /1 Japanese term\(s\) have several English terms/);
  assert.match(first.warnings[0], /"チャンネル": "channel" \(line 2\), "channels" \(line 3\) -> ja to en uses "channel"/);
  assert.equal(renderTerminology(first.rows), "en,ja\nchannel,チャンネル\nchannels,チャンネル\nother,その他\n", "no display_as: file order, byte for byte as before");
  const shown = parseTerms(rev(term("channel", "チャンネル") + term("Channels", "チャンネル", { display: "Channels" }) + term("other", "その他")));
  assert.match(shown.warnings[0], /ja to en uses "Channels"/);
  assert.equal(renderTerminology(shown.rows).trim().split("\n").slice(1).sort().join("|"), "Channels,チャンネル|channel,チャンネル|other,その他", "same entries");
  assert.equal(renderTerminology(shown.rows).split("\n")[1], "Channels,チャンネル", "the row the reverse direction uses comes first in its group");
});
test("terminology: the Japanese key is compared after NFKC and case-insensitively", () => {
  const { warnings } = parseTerms(rev(term("a srt", "ＳＲＴ") + term("b srt", "srt")));
  assert.match(warnings[0], /1 Japanese term\(s\)/);
});
test("terminology: translate_ja_en=n is accepted, still used in reverse by Translate, and says so; other values are errors", () => {
  const { warnings, rows } = parseTerms(rev(term("Zed", "ゼッド", { ja_en: "n" })));
  assert.match(warnings.join("\n"), /translate_ja_en=n on "Zed" \(line 2\).*still used in the ja to en direction/);
  assert.equal(renderTerminology(rows), "en,ja\nZed,ゼッド\n");
  assert.throws(() => parseTerms(rev(term("Zed", "ゼッド", { ja_en: "x" }))), /translate_ja_en must be "y", "n" or empty, got "x"/);
  assert.throws(() => parseTerms(rev(row("A", "あ", "", "", "", "n"))), /polly_en must be "y" or empty/);
});
test("terminology: the builder writes one file and no -ja-en file", () => {
  const d = reverseDir();
  try {
    assert.equal(build(["generate", "--dir", d]).status, 0);
    assert.deepEqual(readdirSync(d).filter((f) => /terminology/.test(f)), ["translate-terminology.csv"]);
    assert.equal(OPTIONAL_OUTPUT_FILES["translate-terminology-ja-en.csv"], undefined);
  } finally {
    cleanup(d);
  }
});
test("terminology: the en to ja entries of the example equal the committed file entry for entry (channel 1 unchanged)", () => {
  const ex = join(REPO, "dictionaries", "example");
  const { rows } = parseTerms(readFileSync(join(ex, "terms.csv"), "utf8"));
  const committed = readFileSync(join(ex, "translate-terminology.csv"), "utf8");
  assert.equal(renderTerminology(rows), committed);
  const want = rows.filter((r) => r.translate_en_ja === "y").map((r) => `${r.en},${r.ja}`).sort();
  assert.deepEqual(committed.trim().split("\n").slice(1).sort(), want);
});
// ---- derived Japanese vocabulary ----
test("vocabulary-ja: every row with a reading is in, Phrase = reading with spaces as hyphens, DisplayAs = en", () => {
  const { rows } = parseTerms(rev(row("Alpha", "", "アルファ") + row("Two Words", "", "ツー ワーズ") + row("None", "", "")));
  assert.deepEqual(vocabularyJaLines(rows), ["アルファ\t\t\tAlpha", "ツー-ワーズ\t\t\tTwo Words"]);
});
test("vocabulary-ja: transcribe_ja=n leaves a row out; phrase_ja overrides the reading; a reading that is no valid Phrase warns", () => {
  const { rows, warnings } = parseTerms(
    rev(row("Alpha", "", "アルファ", "n") + row("Beta", "", "ベータ", "", "", "", "", "べーた") + row("Gamma 3", "", "ガンマ 3") + row("Delta", "", "デルタ")),
  );
  assert.deepEqual(vocabularyJaLines(rows), ["べーた\t\t\tBeta", "デルタ\t\t\tDelta"]);
  assert.ok(warnings.some((w) => /"Gamma 3" \(line 4\).*Set phrase_ja on them, or transcribe_ja=n/.test(w)));
  assert.ok(!warnings.some((w) => /Alpha/.test(w)));
});
