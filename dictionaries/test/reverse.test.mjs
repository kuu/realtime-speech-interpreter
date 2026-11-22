// Reverse direction (Japanese speech to English): columns, flags, generated files, validator rules (node:test).
// Synthetic data only: fixtures/reverse/terms.csv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONAL_OUTPUT_FILES, RESERVED_COLUMNS, parseTerms, renderTerminologyJaEn, renderVocabularyJa, renderReadingsEn, TERMS_HEADER, COLUMNS, REVERSE_COLUMNS } from "../lib/terms.mjs";
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
test("generate writes the three reverse files and today's three, with the documented content", () => {
  const d = reverseDir();
  try {
    const r = build(["generate", "--dir", d]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /transcribe-vocabulary-ja\.txt: 3 entries/);
    assert.match(r.out, /translate-terminology-ja-en\.csv: 9 entries/);
    assert.match(r.out, /polly-readings-en\.csv: 2 entries/);
    assert.equal(
      readFileSync(join(d, "transcribe-vocabulary-ja.txt"), "utf8"),
      "Phrase\tSoundsLike\tIPA\tDisplayAs\nえーだぶりゅーえす\t\t\tAWS\nメディアライブ\t\t\tMediaLive\nエスアールティー\t\t\tSRT\n",
      "Phrase = phrase_ja or reading, DisplayAs = en; transcribe_ja_pos=1 puts AWS first",
    );
    const term = readFileSync(join(d, "translate-terminology-ja-en.csv"), "utf8").trim().split("\n");
    assert.deepEqual(term, [
      "ja,en",
      "佐藤花子,Hanako Sato", // translate_ja_en_pos=2: rows with a position come first
      "MediaLive,MediaLive",
      "メディアライブ,MediaLive",
      "メディアライヴ,MediaLive", // ja_variants; the full-width spelling is the same key as ja after NFKC and is dropped
      "SRT,SRT",
      "エスアールティー,SRT",
      "AWS,AWS",
      "エーダブリューエス,AWS",
      "メディアライブサービス,MediaLive", // the alias row with ja filled
    ]);
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
test("translate_ja_en_pos orders the terminology; the alias row with ja filled is accepted and adds its own row", () => {
  const { rows } = parseTerms(readFileSync(FIXTURE, "utf8"));
  const lines = renderTerminologyJaEn(rows).trim().split("\n");
  assert.equal(lines[0], "ja,en");
  assert.ok(lines.indexOf("佐藤花子,Hanako Sato") < lines.indexOf("MediaLive,MediaLive"), "the row with a position comes first");
  assert.ok(lines.includes("メディアライブサービス,MediaLive"));
});
test("no row has a reverse flag: no reverse file is rendered, written or left behind", () => {
  const d = makeDict("HLS,HLS,エイチエルエス,y,y,y,,,,,,,\n");
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
test("the example dictionary is unchanged: generate --check passes and a fresh generate writes exactly the three files", () => {
  const ex = join(REPO, "dictionaries", "example");
  assert.equal(build(["generate", "--check", "--dir", ex]).status, 0);
  const d = tmp();
  try {
    copyFileSync(join(ex, "terms.csv"), join(d, "terms.csv"));
    assert.equal(build(["generate", "--dir", d]).status, 0);
    assert.deepEqual(readdirSync(d).sort(), ["polly-readings.csv", "terms.csv", "transcribe-vocabulary.txt", "translate-terminology.csv"]);
    for (const f of ["polly-readings.csv", "transcribe-vocabulary.txt", "translate-terminology.csv"]) {
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
test("rules: the Japanese side is unique after NFKC (case-insensitive); the same target twice is harmless, two targets are an error", () => {
  assert.throws(() => parseTerms(rev(row("A", "ＳＲＴ", "", "", "y") + row("B", "srt", "", "", "y"))), /Japanese spelling "srt" maps to "B" but already maps to "A"/);
  const { rows } = parseTerms(rev(row("A", "SRT", "エスアールティー", "", "y").replace(",,,,,,,,,,,,", ",,,,,,,,,,,,") + `A,Ｓｒｔ,,,,,,,,,,,,,y,,,,,,,\n`));
  assert.equal(renderTerminologyJaEn(rows).trim().split("\n").length, 3, "header, SRT, the reading; the NFKC duplicate is dropped");
});
test("rules: ja_variants entries follow the field rules (no comma, quote, TAB)", () => {
  assert.throws(() => parseTerms(rev(`A,あ,,,,,,,,,,,,,y,,,,"x,y",,,\n`)), /ja_variants entry "x,y"/);
});
test("rules: an alias row repeats an en only in the two documented forms; transcribe_ja on an alias row is an error", () => {
  assert.doesNotThrow(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "い", "", "", "y"))));
  assert.throws(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "い", "", "", "y", "y", "ay"))), /duplicate en "A"/);
  assert.throws(() => parseTerms(rev(row("A", "あ", "", "", "y") + row("A", "", "", "y"))), /duplicate en "A"/);
});
test("rules: Transcribe ja-JP phrases are unique", () => {
  assert.throws(() => parseTerms(rev(row("A", "", "アー", "y") + row("B", "", "アー", "y"))), /duplicate Transcribe ja-JP phrase "アー"/);
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
test("validator terminology ja-en: header ja,en, NFKC uniqueness, columns, short-key warning", () => {
  const run = (text) => {
    const d = dirWith({ "translate-terminology-ja-en.csv": text });
    try {
      return validateDictionaryDir(d);
    } finally {
      cleanup(d);
    }
  };
  const ok = run("ja,en\nメディアライブ,MediaLive\nＳＲＴ,SRT\n");
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.counts.terminologyJaEn.entries, 2);
  assert.ok(run("en,ja\nMediaLive,メディアライブ\n").errors.some((e) => /header must be exactly "ja,en"/.test(e)));
  assert.ok(run("ja,en\nＳＲＴ,SRT\nsrt,SRT\n").errors.some((e) => /duplicate ja "srt"/.test(e)));
  assert.ok(run("ja,en\nメディア,Media,X\n").errors.some((e) => /expected 2 columns/.test(e)));
  assert.ok(run("ja,en\n\"x,y\",Z\n").errors.some((e) => /quoted field/.test(e)));
  assert.ok(run("ja,en\nあ,A\n").warnings.some((w) => /one or two characters/.test(w)));
  assert.ok(run("ja,en\nあいう,A \n").errors.some((e) => /leading\/trailing whitespace/.test(e)));
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
