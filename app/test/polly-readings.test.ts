// Unit tests for the Polly pronunciation readings (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeReadings,
  createReadings,
  initReadings,
  parseReadings,
  readingsStartupLine,
} from "../src/polly-readings.js";
import { buildSsml, buildSsmlWithReadings, synthesizeWithFallback } from "../src/speed-control.js";
import { pollyReadings } from "../src/config.js";

const ASSET = fileURLToPath(new URL("../../dictionaries/example/polly-readings.csv", import.meta.url));
const VALIDATE = fileURLToPath(new URL("../../dictionaries/validate.mjs", import.meta.url));
const DICT_DIR = fileURLToPath(new URL("../../dictionaries/example", import.meta.url));

const R = createReadings([
  { term: "MediaPackage", reading: "メディアパッケージ" },
  { term: "AWS Elemental MediaPackage", reading: "AWS エレメンタル メディアパッケージ" },
  { term: "Elemental", reading: "エレメンタル" },
  { term: "SCTE-35", reading: "スカティ さんじゅうご" },
  { term: "SCTE", reading: "スカティ" },
  { term: "SRT", reading: "エスアールティー" },
  { term: "HLS", reading: "エイチエルエス" },
  { term: "AVC", reading: "エーブイシー" },
  { term: "HEVC", reading: "エイチイーブイシー" },
  { term: "DASH", reading: "ダッシュ" },
  { term: "MPEG-DASH", reading: "エムペグ ダッシュ" },
  { term: "ST 2110", reading: "エスティーニィイチイチゼロ" },
  { term: "URL", reading: "ユーアールエル" },
  { term: "A&B", reading: "エーアンドビー" },
]);
const sub = (a: string, t: string) => `<sub alias="${a}">${t}</sub>`;

test("longest match wins", () => {
  assert.equal(
    R.apply("AWS Elemental MediaPackageは").inner,
    sub("AWS エレメンタル メディアパッケージ", "AWS Elemental MediaPackage") + "は",
  );
  assert.equal(R.apply("SCTE-35を").inner, sub("スカティ さんじゅうご", "SCTE-35") + "を");
  assert.equal(R.apply("MPEG-DASHとDASH").inner, sub("エムペグ ダッシュ", "MPEG-DASH") + "と" + sub("ダッシュ", "DASH"));
  assert.equal(R.apply("SCTE").inner, sub("スカティ", "SCTE"));
});

test("boundaries: particles, brackets, commas, glued particle match; Latin/digit neighbours do not", () => {
  assert.equal(R.apply("MediaPackageの設定").hits, 1);
  assert.equal(R.apply("「MediaPackage」").inner, "「" + sub("メディアパッケージ", "MediaPackage") + "」");
  assert.equal(R.apply("SRT、HLS。").inner, sub("エスアールティー", "SRT") + "、" + sub("エイチエルエス", "HLS") + "。");
  assert.equal(R.apply("HLSを使い、URLを").hits, 2);
  assert.equal(R.apply("HLSv2").hits, 0);
  assert.equal(R.apply("XSRT").hits, 0);
  assert.equal(R.apply("SRT2").hits, 0);
  assert.equal(R.apply("2SRT").hits, 0);
  assert.equal(R.apply("MediaPackages").hits, 0);
  assert.equal(R.apply("SRT").hits, 1);
});

test("acronym lists", () => {
  const r = R.apply("AVC と HEVC、SRT、HLS、DASH");
  assert.equal(r.hits, 5);
  assert.equal(
    r.inner,
    [sub("エーブイシー", "AVC"), " と ", sub("エイチイーブイシー", "HEVC"), "、", sub("エスアールティー", "SRT"), "、", sub("エイチエルエス", "HLS"), "、", sub("ダッシュ", "DASH")].join(""),
  );
});

test("case-sensitive", () => {
  assert.equal(R.apply("mediapackage Mediapackage srt Hls").hits, 0);
});

test("escaping in text and alias; no tag injection", () => {
  const r = R.apply(`<break time="5s"/> & "x" 'y' SRT </speak><speak>`);
  assert.equal(r.hits, 1);
  assert.equal(
    r.inner,
    `&lt;break time=&quot;5s&quot;/&gt; &amp; &quot;x&quot; &apos;y&apos; ${sub("エスアールティー", "SRT")} &lt;/speak&gt;&lt;speak&gt;`,
  );
  // a term with XML characters and a hostile alias are escaped too
  const h = createReadings([{ term: "A&B", reading: `x"<y>&` }]);
  assert.equal(h.apply("A&B").inner, `<sub alias="x&quot;&lt;y&gt;&amp;">A&amp;B</sub>`);
  assert.equal(R.apply("A&Bの").inner, sub("エーアンドビー", "A&amp;B") + "の");
  // after removing our own sub tags nothing but escaped text is left
  const stripped = r.inner.replace(/<sub alias="[^"]*">[^<]*<\/sub>/g, "");
  assert.ok(!/[<>]/.test(stripped));
});

test("spaces and hyphens in terms", () => {
  assert.equal(R.apply("ST 2110の").inner, sub("エスティーニィイチイチゼロ", "ST 2110") + "の");
  assert.equal(R.apply("ST  2110").hits, 0);
  assert.equal(R.apply("ST 21100").hits, 0);
  assert.equal(R.apply("MPEG-DASH").hits, 1);
});

test("no-hit text is unchanged byte for byte at 100% (plain path) and escaped identically otherwise", () => {
  const t = "これはテストです。メディアライブ 123";
  assert.equal(buildSsmlWithReadings(t, 100, R).ssml, null);
  assert.equal(buildSsmlWithReadings(t, 100, R).hits, 0);
  assert.equal(buildSsmlWithReadings(t, 120, R).ssml, buildSsml(t, 120));
  assert.equal(R.apply(t).inner, t);
});

test("SSML at 100 and at 110/120/145", () => {
  const t = "MediaPackageを使います";
  const inner = sub("メディアパッケージ", "MediaPackage") + "を使います";
  assert.deepEqual(buildSsmlWithReadings(t, 100, R), { ssml: `<speak>${inner}</speak>`, hits: 1 });
  for (const rate of [110, 120, 145]) {
    assert.deepEqual(buildSsmlWithReadings(t, rate, R), {
      ssml: `<speak><prosody rate="${rate}%">${inner}</prosody></speak>`,
      hits: 1,
    });
  }
  assert.throws(() => buildSsmlWithReadings(t, 99, R));
  assert.throws(() => buildSsmlWithReadings(t, 201, R));
});

test("switch off parity: null readings behave exactly like buildSsml today", () => {
  const t = `MediaPackageと A&B "q"`;
  assert.deepEqual(buildSsmlWithReadings(t, 100, null), { ssml: null, hits: 0 });
  assert.equal(buildSsmlWithReadings(t, 130, null).ssml, buildSsml(t, 130));
  assert.equal(buildSsml(t, 130), `<speak><prosody rate="130%">MediaPackageと A&amp;B &quot;q&quot;</prosody></speak>`);
  assert.equal(buildSsml(t, 100), null);
});

test("fallback: rejected SSML is retried as plain text, original text, rate 100, one warning", async () => {
  const calls: [string, boolean][] = [];
  const warns: string[] = [];
  const once = async (payload: string, ssml: boolean) => {
    calls.push([payload, ssml]);
    if (ssml) throw new Error("InvalidSsmlException");
    return "audio";
  };
  const out = await synthesizeWithFallback("MediaPackageです", 100, R, once, (e) => warns.push(String(e)));
  assert.equal(out.pcm, "audio");
  assert.equal(out.rate, 100);
  assert.equal(out.hits, 0);
  assert.equal(warns.length, 1);
  assert.deepEqual(calls.map((c) => c[1]), [true, false]);
  assert.equal(calls[1][0], "MediaPackageです");
  // a failing plain call still throws (caller logs FAILED stage=synth)
  await assert.rejects(synthesizeWithFallback("x", 100, R, async () => { throw new Error("down"); }, () => {}), /down/);
  // success path: one call, hits reported
  const ok = await synthesizeWithFallback("SRTです", 120, R, async () => "a", () => assert.fail("no warning"));
  assert.equal(ok.hits, 1);
  assert.equal(ok.rate, 120);
  // plain path, no SSML at all
  const plain: boolean[] = [];
  await synthesizeWithFallback("こんにちは", 100, R, async (_p, s) => { plain.push(s); return 1; }, () => {});
  assert.deepEqual(plain, [false]);
});

test("parseReadings: comments, header, bad rows", () => {
  const p = parseReadings("# c\nterm,reading\nA,エー\n\nA,ビー\nB\nC,シー,x\n,x\n");
  assert.deepEqual(p.entries, [{ term: "A", reading: "エー" }]);
  assert.equal(p.problems.length, 4);
  assert.equal(parseReadings("A,エー\n").entries.length, 0);
  assert.equal(createReadings([]).apply("<a>").inner, "&lt;a&gt;");
});

test("the shipped CSV loads, has the five corrected readings, EBU, ARIB, the SCTE rows and every proposal entry", () => {
  const p = parseReadings(readFileSync(ASSET, "utf8"));
  assert.deepEqual(p.problems, []);
  assert.equal(p.entries.length, 82);
  const m = new Map(p.entries.map((e) => [e.term, e.reading]));
  assert.equal(m.get("SCTE"), "スカティ");
  assert.equal(m.get("SPEKE"), "スピーク");
  assert.equal(m.get("SMPTE"), "シンプティ");
  // user's intended spelling is にぃ; katakana ニィ gives the same visemes without Polly's accent-phrase break after に
  assert.equal(m.get("ST 2110"), "エスティーニィイチイチゼロ");
  assert.equal(m.get("ST 2022-7"), "エスティーニィゼロニィニィダッシュセブン");
  assert.equal(m.get("EBU"), "イービーユー");
  assert.equal(m.get("ARIB"), "アライブ");
  assert.equal(m.get("SCTE-35"), "スカティ さんじゅうご");
  assert.equal(m.get("SCTE 35"), "スカティ さんじゅうご");
  assert.equal(m.get("SCTE-104"), "スカティ ひゃくよん");
  assert.equal(m.get("SCTE 104"), "スカティ ひゃくよん");
  for (const [t, rd] of m) if (t.startsWith("SCTE")) assert.ok(rd.startsWith("スカティ"), `${t} must start with スカティ`);
  // no small hiragana in the shipped aliases (they trigger a pitch reset after に)
  for (const [t, rd] of m) assert.ok(!/[ぃぁぅぇぉ]/.test(rd), `${t}: small hiragana in "${rd}"`);
  const r = createReadings(p.entries);
  assert.equal(r.apply("AWS Elemental MediaPackageとMediaLive、MediaConnect。").hits, 3);
  assert.equal(r.apply("AVCとHEVCとSCTE-35").hits, 3);
  assert.equal(r.apply("EBU と ARIB と SCTE 35 と SCTE-104").inner, sub("イービーユー", "EBU") + " と " + sub("アライブ", "ARIB") + " と " + sub("スカティ さんじゅうご", "SCTE 35") + " と " + sub("スカティ ひゃくよん", "SCTE-104"));
  assert.equal(r.apply("ST 2110とST 2022-7").inner, sub("エスティーニィイチイチゼロ", "ST 2110") + "と" + sub("エスティーニィゼロニィニィダッシュセブン", "ST 2022-7"));
});

test("loader: missing file warns loudly and runs without readings (no throw)", () => {
  const s = initReadings("on", "/nonexistent/polly-readings.csv");
  assert.equal(s.loaded, false);
  assert.equal(activeReadings(), null);
  assert.match(readingsStartupLine(s), /LOAD FAILED/);
  const dir = mkdtempSync(join(tmpdir(), "readings-"));
  try {
    const f = join(dir, "r.csv");
    writeFileSync(f, "term,reading\nSRT,エスアールティー\n");
    const ok = initReadings("on", f);
    assert.equal(ok.loaded, true);
    assert.equal(activeReadings()?.apply("SRT").hits, 1);
    assert.match(readingsStartupLine(ok), /pollyReadings=on file=.*entries=1/);
    const off = initReadings("off", f);
    assert.equal(activeReadings(), null);
    assert.match(readingsStartupLine(off), /pollyReadings=off/);
  } finally {
    rmSync(dir, { recursive: true });
    initReadings("off", "");
  }
});

test("POLLY_READINGS parsing is case-insensitive; a bad value falls back to on", () => {
  assert.equal(pollyReadings({ POLLY_READINGS: "OFF" }), "off");
  assert.equal(pollyReadings({ POLLY_READINGS: " On " }), "on");
  assert.equal(pollyReadings({}), "on");
  assert.equal(pollyReadings({ POLLY_READINGS: "maybe" }), "on");
});

function validate(csv: string | null): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "readings-v-"));
  try {
    const f = join(dir, "r.csv");
    if (csv !== null) writeFileSync(f, csv);
    const r = spawnSync("node", [VALIDATE, DICT_DIR, csv === null ? ASSET : f], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("validate.mjs accepts the shipped file", () => {
  const r = validate(null);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /polly-readings\.csv: 82 entries/);
  assert.doesNotMatch(r.out, /WARN/, r.out); // the SCTE-35/104 decision is resolved: no warnings
});

test("validate.mjs rejects bad readings files", () => {
  const H = "term,reading\n";
  const bad: [string, string, RegExp][] = [
    ["duplicate", `${H}SRT,エスアールティー\nSRT,エスアールティー\n`, /duplicate term "SRT"/],
    ["latin reading", `${H}SRT,SRT\n`, /outside katakana|Latin letters/],
    ["quote", `${H}SRT,エス"ティー\n`, /outside katakana/],
    ["lt", `${H}SRT,エス<ティー\n`, /outside katakana/],
    ["amp", `${H}SRT,エス&ティー\n`, /outside katakana/],
    ["gt term", `${H}S>T,エスティー\n`, /contains TAB/],
    ["empty term", `${H},エスティー\n`, /term is empty/],
    ["empty reading", `${H}SRT,\n`, /reading for "SRT" is empty/],
    ["header", `term;reading\nSRT,エス\n`, /header must be/],
    ["columns", `${H}SRT,エス,ティー\n`, /expected 2 columns/],
    ["no newline", `${H}SRT,エス`, /end with a newline/],
  ];
  for (const [name, csv, re] of bad) {
    const r = validate(csv);
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.match(r.out, re, name);
  }
});

test("validate.mjs warns (does not fail) when a longer term's reading disagrees with the shorter term's", () => {
  const r = validate("term,reading\nSCTE,スカティ\nSCTE-35,エスシーティーイー さんじゅうご\n");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARN .*"SCTE-35" contains "SCTE"/);
  const ok = validate("term,reading\nSCTE,スカティ\nSCTE-35,スカティ さんじゅうご\n");
  assert.doesNotMatch(ok.out, /WARN/);
});

// Hard constraint: product names are never altered in text; only the alias changes Polly's sound.
test("every shipped term: the <sub> element text equals the original term byte for byte", () => {
  const p = parseReadings(readFileSync(ASSET, "utf8"));
  const r = createReadings(p.entries);
  for (const { term, reading } of p.entries) {
    for (const text of [term, `「${term}」`, `${term}の設定`]) {
      const out = r.apply(text).inner;
      // longest match may pick a longer entry (e.g. "AWS Elemental MediaPackage"); its text is still the original
      const texts = [...out.matchAll(/<sub alias="[^"]*">([^<]*)<\/sub>/g)].map((m) => m[1]);
      assert.ok(texts.length >= 1, `${term}: no sub in ${out}`);
      const unescape = (x: string) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      // removing alias attributes and tags leaves exactly the original text
      assert.equal(unescape(out.replace(/<sub alias="[^"]*">/g, "").replace(/<\/sub>/g, "")), text, `${term}`);
    }
    assert.equal(r.apply(term).inner, `<sub alias="${reading}">${term}</sub>`);
  }
});

test("no spaces or katakana are inserted into the text outside alias attributes; sentences round-trip", () => {
  const p = parseReadings(readFileSync(ASSET, "utf8"));
  const r = createReadings(p.entries);
  const sentences = [
    "AWS Elemental MediaPackageとMediaConnectを使います。",
    "MediaPackageの「MediaConvert」、MediaTailor、AVC と HEVC、SCTE-35 と SCTE。",
    "ST 2110とST 2022-7、SPEKE、SMPTE、HLSv2、XSRT & <b>",
  ];
  for (const t of sentences) {
    const out = r.apply(t).inner;
    const bare = out.replace(/<sub alias="[^"]*">/g, "").replace(/<\/sub>/g, "");
    assert.equal(bare.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), t);
    assert.ok(!/Media (Package|Connect|Convert|Tailor)/.test(bare));
  }
});

test("POLLY_READINGS=off: the Polly input is identical to today's (plain text at 100, escaped prosody otherwise)", async () => {
  const t = "AWS Elemental MediaPackageとAVC";
  const sent: [string, boolean][] = [];
  await synthesizeWithFallback(t, 100, null, async (p, s) => { sent.push([p, s]); return 1; }, () => {});
  await synthesizeWithFallback(t, 120, null, async (p, s) => { sent.push([p, s]); return 1; }, () => {});
  assert.deepEqual(sent, [[t, false], [`<speak><prosody rate="120%">${t}</prosody></speak>`, true]]);
});
