// Unit tests for the LanguageGate, the Transcribe request builder and LANGUAGE_OPTIONS parsing (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, type Chunk, type SegmenterOptions, type TxItem, type TxResult } from "../src/segmenter.js";
import { LanguageGate, createResultSink, type LanguageGateOptions } from "../src/language-gate.js";
import { transcribeParams } from "../src/transcribe-params.js";
import { parseLanguageOptions } from "../src/config.js";

const DEPLOYED_CONJ = ["because", "but", "although", "though", "while", "which"];
// Deployed segmentation values (= MERGE in segmenter.test.ts).
const MERGE: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: DEPLOYED_CONJ,
  mergeShort: true, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
const GATE: LanguageGateOptions = { source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6 };

// Item times: each ResultId gets its own 100 s slot (in order of first use, reset by make()),
// so results follow each other in stream time like real Transcribe results.
const bases = new Map<string, number>();
const baseOf = (id: string) => {
  if (!bases.has(id)) bases.set(id, bases.size * 100);
  return bases.get(id) as number;
};
function items(text: string, stableCount = Infinity, conf?: number, base = 0): TxItem[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((c, i) => {
      const punct = /^[.,?!;:、。]$/.test(c);
      return {
        Content: c,
        Type: punct ? "punctuation" : "pronunciation",
        Stable: i < stableCount,
        StartTime: base + i * 0.4,
        EndTime: base + i * 0.4 + 0.3,
        ...(conf !== undefined && !punct ? { Confidence: conf } : {}),
      };
    });
}
function partial(id: string, lang: string, text: string, stable: number): TxResult {
  return { ResultId: id, IsPartial: true, LanguageCode: lang, Alternatives: [{ Transcript: text, Items: items(text, stable, undefined, baseOf(id)) }] };
}
function final(id: string, lang: string, text: string, conf = 0.95): TxResult {
  const its = items(text, 0, conf, baseOf(id));
  return {
    ResultId: id, IsPartial: false, LanguageCode: lang, StartTime: 0, EndTime: its.length * 0.4,
    Alternatives: [{ Transcript: text, Items: its }],
  };
}
function captureLogs<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => {
    lines.push(a.slice(1).map(String).join(" "));
  };
  const l = mock.method(console, "log", rec);
  const e = mock.method(console, "error", rec);
  try {
    return { result: fn(), lines };
  } finally {
    l.mock.restore();
    e.mock.restore();
  }
}
function make(opts: LanguageGateOptions = GATE): { seg: Segmenter; gate: LanguageGate; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  const seg = new Segmenter(MERGE, (c) => chunks.push(c));
  bases.clear();
  return { seg, gate: new LanguageGate(opts, seg, () => 0), chunks };
}
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/ ([.,?!;:])/g, "$1").trim();
const joined = (chunks: Chunk[]) => norm(chunks.map((c) => c.english).join(" "));
const verifyLines = (lines: string[]) => lines.filter((l) => l.startsWith("[verify]"));
const dropLines = (lines: string[]) => lines.filter((l) => l.startsWith("[langfilter] dropped"));

// Feed a growing en-US result word by word with `lagStable` unstable trailing words.
function growing(gate: LanguageGate, id: string, lang: string, text: string, t: number, lagStable = 2): number {
  const words = text.split(" ");
  for (let n = 1; n <= words.length; n++) {
    gate.onResult(partial(id, lang, words.slice(0, n).join(" "), Math.max(0, n - lagStable)), t);
    t += 100;
  }
  return t;
}

test("a) en-US result: nothing before settling, then exact text, verify OK", () => {
  const { gate, chunks } = make();
  const text = "we are building a new service for live video , and it runs in the cloud every day for customers .";
  const { lines } = captureLogs(() => {
    gate.onResult(partial("r1", "en-US", "we are building a new", 4), 0);
    gate.onResult(partial("r1", "en-US", "we are building a new service", 4), 100);
    assert.equal(chunks.length, 0);
    growing(gate, "r1", "en-US", text, 200);
    gate.onResult(final("r1", "en-US", text), 5000);
  });
  assert.equal(joined(chunks), norm(text));
  const v = verifyLines(lines);
  assert.equal(v.length, 1);
  assert.match(v[0], / OK /);
  assert.equal(gate.stats.kept, 1);
  assert.equal(gate.stats.dropped, 0);
});

test("b) all-ja-JP result: no chunks, one drop line", () => {
  const { gate, chunks } = make();
  const { lines } = captureLogs(() => {
    growing(gate, "j1", "ja-JP", "はい 、 それ では 始め たい と 思い ます 。", 0, 1);
    gate.onResult(final("j1", "ja-JP", "はい 、 それ では 始め たい と 思い ます 。", 0.9), 2000);
    gate.endOfStream("eof", 3000);
  });
  assert.equal(chunks.length, 0);
  assert.equal(gate.stats.dropped, 1);
  assert.equal(gate.stats.droppedWords, 8);
  const d = dropLines(lines);
  assert.equal(d.length, 1);
  // 10 items → EndTime 4.0 s; now 2000 ms, t0 0 → lagMs −2000.
  assert.match(d[0], /^\[langfilter\] dropped result=j1 reason=non-english lang=ja-JP words=8 conf=0\.90 audio=0\.00-4\.00s lagMs=-2000 text="はい 、 それ では .*"$/);
  assert.equal(verifyLines(lines).length, 0);
});

test("c) en→ja flip before settling: no chunks", () => {
  const { gate, chunks } = make();
  captureLogs(() => {
    gate.onResult(partial("f1", "en-US", "Hi , S", 1), 0);
    gate.onResult(partial("f1", "en-US", "Hi , So me", 3), 300);
    gate.onResult(partial("f1", "ja-JP", "はい 、 それ では", 2), 1200);
    gate.onResult(partial("f1", "ja-JP", "はい 、 それ では 質問 です", 5), 1500);
    gate.onResult(final("f1", "ja-JP", "はい 、 それ では 質問 です 。"), 3000);
    gate.endOfStream("eof", 10_000);
  });
  assert.equal(chunks.length, 0);
  assert.equal(gate.stats.dropped, 1);
});

test("d) ja→en flip: the full English text is emitted", () => {
  const { gate, chunks } = make();
  const text = "can I ask you to clarify how the bandwidth is shared between the two regions ?";
  const { lines } = captureLogs(() => {
    gate.onResult(partial("e1", "ja-JP", "キャン アイ", 1), 0);
    gate.onResult(partial("e1", "ja-JP", "キャン アイ アスク", 2), 300);
    growing(gate, "e1", "en-US", text, 600);
    gate.onResult(final("e1", "en-US", text), 5000);
  });
  assert.equal(joined(chunks), norm(text));
  assert.ok(verifyLines(lines).every((l) => / OK /.test(l)));
  assert.equal(gate.stats.dropped, 0);
});

test("e) late flip after settling: held tokens removed, LANGDROP, no MISMATCH", () => {
  const { gate, chunks, seg } = make();
  const { lines } = captureLogs(() => {
    // 6 stable words, no cut yet (minWords 8) → held in pending.
    gate.onResult(partial("l1", "en-US", "one two three four five six x", 6), 0);
    assert.equal(seg.pendingTokens, 6);
    gate.onResult(final("l1", "ja-JP", "ワン ツー スリー フォー ファイブ シックス 。"), 1000);
    seg.tick(10_000);
    gate.endOfStream("eof", 20_000);
  });
  assert.equal(chunks.length, 0);
  assert.equal(gate.stats.late, 1);
  assert.equal(gate.stats.dropped, 1);
  const v = verifyLines(lines);
  assert.equal(v.length, 1);
  assert.match(v[0], /LANGDROP lang=ja-JP/);
  assert.ok(!v.some((l) => /MISMATCH/.test(l)));
  assert.match(dropLines(lines)[0], /reason=non-english-late/);
});

test("f) short-low-conf rule", () => {
  // prev final ja-JP + short low-confidence en → dropped
  {
    const { gate, chunks } = make();
    const { lines } = captureLogs(() => {
      gate.onResult(final("j", "ja-JP", "質問 です 。"), 0);
      gate.onResult(partial("s", "en-US", "more", 0), 100);
      gate.onResult(final("s", "en-US", "more .", 0.5), 500);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(chunks.length, 0);
    assert.match(dropLines(lines).at(-1)!, /reason=short-low-conf lang=en-US words=1 conf=0\.50/);
  }
  // high confidence → kept
  {
    const { gate, chunks } = make();
    captureLogs(() => {
      gate.onResult(final("j", "ja-JP", "質問 です 。"), 0);
      gate.onResult(final("s", "en-US", "thank you .", 0.9), 500);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(joined(chunks), "thank you.");
  }
  // previous final en-US → kept
  {
    const { gate, chunks } = make();
    captureLogs(() => {
      gate.onResult(final("a", "en-US", "this is a long english sentence with many words ."), 0);
      gate.onResult(final("s", "en-US", "more .", 0.5), 500);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(joined(chunks), "this is a long english sentence with many words. more.");
  }
  // rule disabled
  {
    const { gate, chunks } = make({ ...GATE, shortWords: 0 });
    captureLogs(() => {
      gate.onResult(final("j", "ja-JP", "質問 です 。"), 0);
      gate.onResult(final("s", "en-US", "more .", 0.5), 500);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(joined(chunks), "more.");
  }
  // first result of the stream (no previous final) → kept
  {
    const { gate, chunks } = make();
    captureLogs(() => {
      gate.onResult(final("s", "en-US", "more .", 0.5), 500);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(joined(chunks), "more.");
  }
  // a chain of fragments inside a Japanese passage: both dropped
  {
    const { gate, chunks } = make();
    captureLogs(() => {
      gate.onResult(final("j", "ja-JP", "質問 です 。"), 0);
      gate.onResult(final("s1", "en-US", "sleep .", 0.52), 500);
      gate.onResult(final("s2", "en-US", "I'll see .", 0.51), 900);
      gate.endOfStream("eof", 10_000);
    });
    assert.equal(chunks.length, 0);
  }
});

test("g) endOfStream: unsettled en partial committed with reason eof; unsettled ja partial dropped", () => {
  {
    const { gate, chunks } = make();
    captureLogs(() => {
      gate.onResult(partial("u", "en-US", "thank you all", 1), 0);
      gate.endOfStream("eof", 500);
    });
    assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["thank you all", "eof"]]);
  }
  {
    const { gate, chunks } = make();
    const { lines } = captureLogs(() => {
      gate.onResult(partial("u", "ja-JP", "ありがとう ござい ました", 1), 0);
      gate.endOfStream("error", 500);
    });
    assert.equal(chunks.length, 0);
    assert.match(dropLines(lines)[0], /reason=non-english-eof lang=ja-JP/);
  }
});

test("h) Q&A: en answer / ja question / en answer → both answers in order, no Japanese", () => {
  const { gate, chunks } = make();
  const a1 = "yes , the entitlement is shared across all the flows in the account .";
  const q = "すみません 、 もう 一つ 質問 が あり ます 。";
  const a2 = "and if the entitlement is removed the flow stops within a few seconds .";
  const { lines } = captureLogs(() => {
    let t = growing(gate, "a1", "en-US", a1, 0);
    gate.onResult(final("a1", "en-US", a1), t);
    t = growing(gate, "q", "ja-JP", q, t + 500, 1);
    gate.onResult(final("q", "ja-JP", q, 0.9), t);
    t = growing(gate, "a2", "en-US", a2, t + 500);
    gate.onResult(final("a2", "en-US", a2), t);
    gate.endOfStream("eof", t + 5000);
  });
  assert.equal(joined(chunks), norm(`${a1} ${a2}`));
  assert.ok(!chunks.some((c) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(c.english)));
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.ok(v.every((l) => / OK /.test(l)));
  assert.equal(gate.stats.dropped, 1);
  assert.equal(gate.stats.kept, 2);
  assert.match(gate.summary(1), /^\[langfilter\] stream=1 results=3 kept=2 dropped=1 droppedWords=7 late=0 carried=0 repeats=0$/);
});

// ───────── split results (language ID): a final shorter than its committed items, the rest repeated by the next result ─────────

// Items whose times come from their position in the whole utterance (so a repeated item has the same StartTime).
function at(words: string[], from: number, to: number, stable: number, conf?: number): TxItem[] {
  return words.slice(from, to).map((c, j) => {
    const i = from + j;
    const punct = /^[.,?!]$/.test(c);
    return {
      Content: c, Type: punct ? "punctuation" : "pronunciation", Stable: j < stable,
      StartTime: i * 0.4, EndTime: i * 0.4 + 0.3, ...(conf !== undefined && !punct ? { Confidence: conf } : {}),
    };
  });
}
const P = (id: string, its: TxItem[]): TxResult => ({ ResultId: id, IsPartial: true, LanguageCode: "en-US", Alternatives: [{ Items: its }] });
const F = (id: string, its: TxItem[]): TxResult => ({ ResultId: id, IsPartial: false, LanguageCode: "en-US", Alternatives: [{ Items: its }] });

test("k) split: the repeated items are not spoken twice, verify OK", () => {
  const { gate, chunks, seg } = make();
  const w = "Hi everybody , my name is Alex and I am a product manager with Elemental . I focus on core video .".split(" ");
  const iManager = w.indexOf("manager");
  const { lines } = captureLogs(() => {
    // A: everything up to "on" is stable and committed.
    const end = w.indexOf("on") + 1;
    gate.onResult(P("A", at(w, 0, end, end)), 0);
    // A's final stops after "manager"; "with Elemental . I focus on" moves to B.
    gate.onResult(F("A", at(w, 0, iManager + 1, 0, 0.9)), 1000);
    gate.onResult(P("B", at(w, iManager + 1, w.length, 3)), 1100);
    gate.onResult(P("B", at(w, iManager + 1, w.length, w.length)), 1300);
    gate.onResult(F("B", at(w, iManager + 1, w.length, 0, 0.9)), 1500);
    gate.endOfStream("eof", 5000);
  });
  assert.equal(joined(chunks), norm(w.join(" ")));
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.ok(v.every((l) => / OK /.test(l)), v.join("\n"));
  assert.equal(gate.stats.carried, 1);
  assert.ok(lines.some((l) => /^\[langfilter\] carry result=A items=6 text="with Elemental \. I focus on"/.test(l)));
  assert.equal(seg.pendingTokens, 0);
});

test("l) chained split: B's final ends inside the carry, C repeats the rest", () => {
  const { gate, chunks } = make();
  const w = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen .".split(" ");
  const { lines } = captureLogs(() => {
    gate.onResult(P("A", at(w, 0, 12, 12)), 0); // one..twelve committed
    gate.onResult(F("A", at(w, 0, 7, 0)), 500); // final: one..seven → carry eight..twelve
    gate.onResult(P("B", at(w, 7, 10, 3)), 600); // eight nine ten (all repeats)
    gate.onResult(F("B", at(w, 7, 10, 0)), 800); // final: eight nine ten → carry eleven twelve
    gate.onResult(P("C", at(w, 10, 15, 5)), 900); // eleven twelve thirteen fourteen .
    gate.onResult(F("C", at(w, 10, 15, 0)), 1200);
    gate.endOfStream("eof", 5000);
  });
  assert.equal(joined(chunks), norm(w.join(" ")));
  assert.ok(verifyLines(lines).every((l) => / OK /.test(l)), verifyLines(lines).join("\n"));
  assert.equal(gate.stats.carried, 1);
  assert.equal(gate.stats.repeats, 2); // B and C repeated committed audio
});

test("n) split where the next result starts earlier than the overflow (re-transcribes finalized audio)", () => {
  // Seen in E3: A = "...out because Ford because Ford and because Ford , oh sorry , Toyota would object if that message"
  // final ends at "sorry ,"; B's partials start at the 2nd "because Ford", B's final at "oh sorry".
  const { gate, chunks } = make();
  const w = "the news channel does not want to cut out because Ford because Ford , oh sorry , Toyota would object if that message was cut out .".split(" ");
  const iOh = w.indexOf("oh");
  const iToyota = w.indexOf("Toyota");
  const iMsg = w.indexOf("message");
  const { lines } = captureLogs(() => {
    gate.onResult(P("A", at(w, 0, iMsg + 1, iMsg + 1)), 0); // all committed up to "message"
    gate.onResult(F("A", at(w, 0, iToyota, 0)), 500); // final stops before "Toyota"
    gate.onResult(P("B", at(w, w.indexOf("Ford") + 1, w.length, 6)), 600); // "because Ford , oh sorry , Toyota …"
    gate.onResult(P("B", at(w, w.indexOf("Ford") + 1, w.length, 30)), 800);
    gate.onResult(F("B", at(w, iOh, w.length, 0)), 1000); // final starts at "oh"
    gate.endOfStream("eof", 5000);
  });
  assert.equal(joined(chunks), norm(w.join(" ")));
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.ok(v.every((l) => / OK /.test(l)), v.join("\n"));
  assert.ok(!lines.some((l) => /committed item changed/.test(l)));
});

test("m) a carry the next result does not repeat is ignored", () => {
  const { gate, chunks } = make();
  const a = "this is the first english sentence that we say here".split(" ");
  const b = "completely different words come next in this one .".split(" ");
  captureLogs(() => {
    gate.onResult(P("A", at(a, 0, a.length, a.length)), 0);
    gate.onResult(F("A", at(a, 0, 6, 0)), 500); // carry "that we say here"
    gate.onResult(P("B", at(b, 0, b.length, b.length).map((it) => ({ ...it, StartTime: (it.StartTime ?? 0) + 10 }))), 600);
    gate.onResult(F("B", at(b, 0, b.length, 0).map((it) => ({ ...it, StartTime: (it.StartTime ?? 0) + 10 }))), 900);
    gate.endOfStream("eof", 5000);
  });
  assert.equal(joined(chunks), norm(`${a.join(" ")} ${b.join(" ")}`));
});

test("missing LanguageCode is treated as the source language", () => {
  const { gate, chunks } = make();
  const r = final("x", "en-US", "this has no language code at all , fine .");
  delete r.LanguageCode;
  captureLogs(() => {
    gate.onResult(r, 0);
    gate.endOfStream("eof", 100);
  });
  assert.equal(joined(chunks), "this has no language code at all, fine.");
});

test("i) off switch: the sink is the segmenter itself; request params", () => {
  const seg = new Segmenter(MERGE, () => {});
  assert.equal(createResultSink("off", seg, GATE, () => 0), seg);
  assert.ok(createResultSink("langid", seg, GATE, () => 0) instanceof LanguageGate);

  const t = { languageCode: "en-US", vocabularyName: "simul-translation", partialResultsStability: "high" };
  // Today's literal request (pipeline.ts before the language filter), minus AudioStream.
  assert.deepStrictEqual(transcribeParams(t, 16000, { mode: "off", options: ["en-US", "ja-JP"] }), {
    LanguageCode: "en-US",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    VocabularyName: "simul-translation",
    EnablePartialResultsStabilization: true,
    PartialResultsStability: "high",
  });
  assert.deepStrictEqual(transcribeParams({ ...t, vocabularyName: "" }, 16000, { mode: "off", options: [] }), {
    LanguageCode: "en-US",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    EnablePartialResultsStabilization: true,
    PartialResultsStability: "high",
  });
  const p = transcribeParams(t, 16000, { mode: "langid", options: ["en-US", "ja-JP"] });
  assert.deepStrictEqual(p, {
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    IdentifyMultipleLanguages: true,
    LanguageOptions: "en-US,ja-JP",
    PreferredLanguage: "en-US",
    VocabularyNames: "simul-translation",
    EnablePartialResultsStabilization: true,
    PartialResultsStability: "high",
  });
  assert.ok(!("LanguageCode" in p) && !("VocabularyName" in p));
  const p2 = transcribeParams({ ...t, vocabularyName: "" }, 16000, { mode: "langid", options: ["en-US", "ja-JP"] });
  assert.ok(!("VocabularyNames" in p2));
});

test("i) off switch: results reach the segmenter unchanged (Japanese is translated, as before)", () => {
  const chunks: Chunk[] = [];
  const seg = new Segmenter(MERGE, (c) => chunks.push(c));
  const sink = createResultSink("off", seg, GATE, () => 0);
  captureLogs(() => {
    sink.onResult(final("j", "ja-JP", "makochio makochio makochio makochio makochio makochio makochio makochio ."), 0);
    sink.endOfStream("eof", 100);
  });
  assert.equal(chunks.length, 1);
});

test("j) parseLanguageOptions", () => {
  assert.deepEqual(parseLanguageOptions("en-US,ja-JP", "en-US"), ["en-US", "ja-JP"]);
  assert.deepEqual(parseLanguageOptions(" en-US , ja-JP ,ko-KR", "en-US"), ["en-US", "ja-JP", "ko-KR"]);
  assert.equal(parseLanguageOptions("ja-JP,ko-KR", "en-US"), null); // missing source
  assert.equal(parseLanguageOptions("en-US", "en-US"), null); // single code
  assert.equal(parseLanguageOptions("en-US,en-GB", "en-US"), null); // duplicate language
  assert.equal(parseLanguageOptions("en-US,japanese", "en-US"), null); // bad code
  assert.equal(parseLanguageOptions("en-US,ja-jp", "en-US"), null); // bad case
  assert.equal(parseLanguageOptions("en-US,ja-JP,ko-KR,zh-CN,fr-FR,de-DE", "en-US"), null); // > 5
});
test("k) complete-sentence release (sentenceCompleteWords=5) commits no Japanese and nothing unsettled earlier", () => {
  // The same event list through the gate with cw 0 and cw 5. The gate decides language before
  // anything reaches the segmenter, so cw 5 must not let any word of a non-en-US result out,
  // and must not emit an en-US result before it settles (stable prefix < settleWords).
  const run = (cw: number) => {
    const chunks: Chunk[] = [];
    const seg = new Segmenter({ ...MERGE, sentenceCompleteWords: cw }, (c) => chunks.push(c));
    bases.clear();
    const gate = new LanguageGate(GATE, seg, () => 0);
    const at: Record<string, number> = {};
    const { lines } = captureLogs(() => {
      // (i) English-looking 7-word sentence tagged ja-JP throughout
      growing(gate, "j1", "ja-JP", "We have about ten minutes left .", 0, 1);
      gate.onResult(final("j1", "ja-JP", "We have about ten minutes left ."), 1000);
      // (i) Japanese sentence
      growing(gate, "j2", "ja-JP", "これ は テスト です と 思い ます 。", 1100, 1);
      gate.onResult(final("j2", "ja-JP", "これ は テスト です と 思い ます 。"), 2200);
      // en→ja flip before settling (4 stable words, then ja-JP)
      gate.onResult(partial("f1", "en-US", "Is that a function you", 4), 2300);
      gate.onResult(partial("f1", "ja-JP", "それ は 機能 です か ?", 4), 2500);
      gate.onResult(final("f1", "ja-JP", "それ は 機能 です か ?"), 3000);
      // (ii) en-US, 4 stable words, "." unstable: not settled → nothing emitted yet
      gate.onResult(partial("e1", "en-US", "We have ten minutes .", 4), 3100);
      at.beforeFinal = chunks.length;
      gate.onResult(final("e1", "en-US", "We have ten minutes ."), 3600);
      seg.tick(5100); // merge_pause releases the held 4-word sentence
      at.afterFinal = chunks.length;
      // en-US complete 6-word sentence (settled): released by cw 5 immediately, held by cw 0
      gate.onResult(partial("e2", "en-US", "Is that a function you use ? X", 7), 5200);
      at.afterE2 = chunks.length;
      gate.onResult(final("e2", "en-US", "Is that a function you use ?"), 5500);
      seg.tick(10_000);
      gate.endOfStream("eof", 20_000);
    });
    return { chunks, lines, at };
  };
  const a = run(0);
  const b = run(5);
  for (const r of [a, b]) {
    const text = r.chunks.map((c) => c.english).join(" ");
    assert.ok(!/[ぁ-んァ-ン一-龯]/.test(text), text);
    assert.ok(!/left|ten minutes left/.test(text), text); // no word of j1
    assert.ok(r.chunks.every((c) => Object.keys(c.resultCounts).every((id) => id === "e1" || id === "e2")), JSON.stringify(r.chunks));
    assert.equal(r.at.beforeFinal, 0);
    assert.ok(!verifyLines(r.lines).some((l) => /MISMATCH/.test(l)));
  }
  // Same words out, in the same order (cw 5 only changes where/when the cut happens).
  assert.equal(joined(b.chunks), joined(a.chunks));
  assert.equal(joined(b.chunks), "We have ten minutes. Is that a function you use?");
  // cw 5: the 6-word question is cut as soon as its "?" is stable; cw 0 holds it (merge).
  assert.equal(a.at.afterFinal, 1);
  assert.equal(b.at.afterFinal, 1);
  assert.equal(b.at.afterE2, 2);
  assert.equal(a.at.afterE2, 1);
});

// ---- dynamic settle (LANGID_SETTLE_MODE=dynamic) ------------------------------------------------
import { existsSync, readFileSync } from "node:fs";
import type { Segmenter as SegmenterT } from "../src/segmenter.js";
const DYN: LanguageGateOptions = {
  ...GATE, settleWords: 4, settleMode: "dynamic", settleWordsDefault: 3, settleWordsAfterJa: 5, jaMemoryMs: 20000,
};
// Records which results (and how many words) reach the segmenter; the gate only needs these four calls.
function stub(opts: LanguageGateOptions): { gate: LanguageGate; fwd: string[] } {
  const fwd: string[] = [];
  const seg = {
    onResult: (r: TxResult) => { if (r.IsPartial) fwd.push(r.ResultId ?? ""); },
    noteActivity: () => {}, closeResult: () => {}, endOfStream: () => {},
  } as unknown as SegmenterT;
  bases.clear();
  return { gate: new LanguageGate(opts, seg, () => 0), fwd };
}
const WORDS = "one two three four five six";
test("dynamic: no non-English result seen → 3 stable words settle a result", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(partial("a", "en-US", WORDS, 2), 1000);
  assert.deepEqual(fwd, []);
  gate.onResult(partial("a", "en-US", WORDS, 3), 1100);
  assert.deepEqual(fwd, ["a"]);
});
test("dynamic: after a ja-JP result the threshold is 5 stable words", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(partial("j", "ja-JP", "はい 、 ありがとう", 1), 1000);
  for (const n of [3, 4]) gate.onResult(partial("b", "en-US", WORDS, n), 2000 + n);
  assert.deepEqual(fwd, [], "3 and 4 stable words are not enough right after Japanese");
  gate.onResult(partial("b", "en-US", WORDS, 5), 2100);
  assert.deepEqual(fwd, ["b"]);
  assert.equal(gate.stats.settledAfterJa, 1);
});
test("dynamic: a ja-JP final alone (no partial) also arms the long threshold", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(final("j", "ja-JP", "はい 、 ありがとう"), 1000);
  gate.onResult(partial("b", "en-US", WORDS, 4), 2000);
  assert.deepEqual(fwd, []);
  gate.onResult(partial("b", "en-US", WORDS, 5), 2100);
  assert.deepEqual(fwd, ["b"]);
});
test("dynamic: the window expires after jaMemoryMs (boundary inclusive), then 3 words settle again", () => {
  const a = stub(DYN);
  a.gate.onResult(partial("j", "ja-JP", "はい 、 ありがとう", 1), 1000);
  a.gate.onResult(partial("b", "en-US", WORDS, 3), 21000); // exactly 20000 ms later: still after-JA
  assert.deepEqual(a.fwd, []);
  a.gate.onResult(partial("c", "en-US", WORDS, 3), 21001); // 20001 ms later: expired
  assert.deepEqual(a.fwd, ["c"]);
  const b = stub({ ...DYN, jaMemoryMs: 5000 });
  b.gate.onResult(partial("j", "ja-JP", "はい 、 ありがとう", 1), 1000);
  b.gate.onResult(partial("x", "en-US", WORDS, 3), 5000);
  assert.deepEqual(b.fwd, []);
  b.gate.onResult(partial("y", "en-US", WORDS, 3), 6001);
  assert.deepEqual(b.fwd, ["y"]);
});
test("dynamic: a result that starts ja-JP and flips to en-US needs 5 stable words itself", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(partial("f", "ja-JP", "はい 、 ありがとう", 1), 50000);
  gate.onResult(partial("f", "en-US", WORDS, 4), 50100);
  assert.deepEqual(fwd, []);
  gate.onResult(partial("f", "en-US", WORDS, 5), 50200);
  assert.deepEqual(fwd, ["f"]);
});
test("dynamic: a result whose partials shrank before settling needs 5 stable words even with no Japanese seen", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(partial("v", "en-US", "I , I", 1), 1000);
  gate.onResult(partial("v", "en-US", "I", 1), 1100); // fewer items than before: Transcribe is rewriting
  gate.onResult(partial("v", "en-US", WORDS, 3), 1200);
  gate.onResult(partial("v", "en-US", WORDS, 4), 1300);
  assert.deepEqual(fwd, []);
  gate.onResult(partial("v", "en-US", WORDS, 5), 1400);
  assert.deepEqual(fwd, ["v"]);
  // a steadily growing result is not volatile
  gate.onResult(partial("g", "en-US", "one two", 1), 2000);
  gate.onResult(partial("g", "en-US", "one two three", 2), 2100);
  gate.onResult(partial("g", "en-US", WORDS, 3), 2200);
  assert.deepEqual(fwd, ["v", "g"]);
  // fixed mode ignores shrinking
  const f = stub({ ...GATE, settleWords: 3 });
  f.gate.onResult(partial("v", "en-US", "I , I", 1), 1000);
  f.gate.onResult(partial("v", "en-US", "I", 1), 1100);
  f.gate.onResult(partial("v", "en-US", WORDS, 3), 1200);
  assert.deepEqual(f.fwd, ["v"]);
});
test("dynamic: an English partial never arms the window, and a forwarded result is not re-settled", () => {
  const { gate, fwd } = stub(DYN);
  gate.onResult(partial("a", "en-US", WORDS, 3), 1000);
  gate.onResult(partial("j", "ja-JP", "はい 、 ありがとう", 1), 1100); // a later ja result does not un-pass a
  gate.onResult(partial("a", "en-US", WORDS, 3), 1200);
  assert.deepEqual(fwd, ["a", "a"]);
  assert.equal(gate.stats.settledAfterJa, 0);
});
test("settleMode fixed (or absent) ignores the dynamic values: every result needs settleWords", () => {
  for (const opts of [{ ...DYN, settleMode: "fixed" as const, settleWords: 5 }, { ...GATE, settleWords: 5 }]) {
    const { gate, fwd } = stub(opts);
    gate.onResult(partial("a", "en-US", WORDS, 4), 1000);
    assert.deepEqual(fwd, []);
    gate.onResult(partial("a", "en-US", WORDS, 5), 1100);
    assert.deepEqual(fwd, ["a"]);
  }
});
test("summary line shows settledAfterJa only in dynamic mode", () => {
  assert.match(new LanguageGate(DYN, stub(DYN).gate as never, () => 0).summary(1), /settledAfterJa=0/);
  assert.doesNotMatch(new LanguageGate(GATE, stub(GATE).gate as never, () => 0).summary(1), /settledAfterJa/);
});

// Recorded Transcribe language-ID streams (not part of this repository; the tests below skip when absent): wall = ms since the stream start.
const PROBE = new URL("../../../test-data/ja-filter-probe/", import.meta.url).pathname;
interface Row { wall: number; id: string; partial: boolean; start: number; end: number; lang: string | null; items: [string, number, number | null, string, number?, number?][]; text: string }
function replayStream(file: string, opts: LanguageGateOptions): { chunks: Chunk[]; lines: string[]; leaked: number; stats: LanguageGate["stats"] } {
  const rows: Row[] = readFileSync(PROBE + file + ".jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const finalLang = new Map<string, string>();
  for (const r of rows) if (!r.partial) finalLang.set(r.id, r.lang ?? "en-US");
  const { result, lines } = captureLogs(() => {
    const chunks: Chunk[] = [];
    const seg = new Segmenter(MERGE, (c) => chunks.push(c));
    const forwarded = new Set<string>();
    const orig = seg.onResult.bind(seg);
    seg.onResult = (r: TxResult, now: number) => { if (r.IsPartial && r.ResultId) forwarded.add(r.ResultId); orig(r, now); };
    const gate = new LanguageGate(opts, seg, () => 0);
    let last = 0;
    for (const r of rows) {
      for (let t = last + 200; t < r.wall; t += 200) seg.tick(t);
      last = r.wall;
      gate.onResult({
        ResultId: r.id, IsPartial: r.partial, LanguageCode: r.lang ?? undefined, StartTime: r.start, EndTime: r.end,
        Alternatives: [{ Transcript: r.text, Items: r.items.map((i) => ({ Content: i[0], Stable: !!i[1], Confidence: i[2] ?? undefined, Type: i[3], StartTime: i[4], EndTime: i[5] })) }],
      }, r.wall);
    }
    gate.endOfStream("eof", last + 100);
    return { chunks, gate, forwarded };
  });
  // leaked = results forwarded to the segmenter as partials whose final language is not the source
  const leaked = [...result.forwarded].filter((id) => (finalLang.get(id) ?? "en-US") !== "en-US").length;
  return { chunks: result.chunks, lines, leaked, stats: result.gate.stats };
}
const STREAMS = ["j1_langid", "j2_langid", "j3_langid", "e1_langid", "e2_langid", "e3_langid", "e4_langid"];
const haveProbe = STREAMS.every((f) => existsSync(PROBE + f + ".jsonl"));
test("replay: fixed mode is identical to the gate without the new options (chunks, log lines, stats)", { skip: !haveProbe }, () => {
  for (const f of STREAMS) {
    const legacy = replayStream(f, { ...GATE, settleWords: 4 });
    const fixed = replayStream(f, { ...DYN, settleMode: "fixed", settleWords: 4 });
    assert.deepEqual(fixed.chunks.map((c) => [c.english, c.reason]), legacy.chunks.map((c) => [c.english, c.reason]), f);
    assert.deepEqual(fixed.lines, legacy.lines, f);
    assert.deepEqual({ ...fixed.stats }, { ...legacy.stats }, f);
  }
});
test("replay J1-J3: dynamic settle leaks no more Japanese results than fixed 4 and none on J1/J2; no English is lost", { skip: !haveProbe }, () => {
  for (const f of ["j1_langid", "j2_langid", "j3_langid"]) {
    const fixed4 = replayStream(f, { ...GATE, settleWords: 4 });
    const dyn = replayStream(f, DYN);
    assert.ok(dyn.leaked <= fixed4.leaked, `${f}: dynamic ${dyn.leaked} vs fixed4 ${fixed4.leaked}`);
    if (f !== "j3_langid") assert.equal(dyn.leaked, 0, f);
    assert.equal(dyn.lines.filter((l) => l.startsWith("[verify]") && /MISMATCH/.test(l)).length, 0, f);
    assert.ok(dyn.stats.settledAfterJa > 0, `${f}: the after-JA threshold was used`);
  }
  // E1-E4 contain no Japanese: nothing is dropped differently, the same words reach the segmenter as with fixed 3
  for (const f of ["e1_langid", "e2_langid", "e3_langid", "e4_langid"]) {
    const dyn = replayStream(f, DYN);
    assert.equal(dyn.leaked, 0, f);
    assert.equal(dyn.lines.filter((l) => /MISMATCH/.test(l)).length, 0, f);
  }
});
