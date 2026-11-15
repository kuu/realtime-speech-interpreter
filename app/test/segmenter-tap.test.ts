// Exactly-once check of the segmenter tap (live English captions) through the real LanguageGate (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, type Chunk, type SegmenterOptions, type SegmenterTap, type TxItem, type TxResult } from "../src/segmenter.js";
import { LanguageGate, createResultSink, type LanguageGateOptions } from "../src/language-gate.js";

const CONJ = ["because", "but", "although", "though", "while", "which"];
const MERGE: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: CONJ,
  mergeShort: true, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
const SENTENCE: SegmenterOptions = { ...MERGE, mode: "sentence", mergeShort: false };
const GATE: LanguageGateOptions = { source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6 };

const bases = new Map<string, number>();
const baseOf = (id: string) => {
  if (!bases.has(id)) bases.set(id, bases.size * 100);
  return bases.get(id) as number;
};
function items(text: string, stableCount = Infinity, conf?: number, base = 0): TxItem[] {
  return text.split(/\s+/).filter(Boolean).map((c, i) => {
    const punct = /^[.,?!;:]$/.test(c);
    return {
      Content: c, Type: punct ? "punctuation" : "pronunciation", Stable: i < stableCount,
      StartTime: base + i * 0.4, EndTime: base + i * 0.4 + 0.3,
      ...(conf !== undefined && !punct ? { Confidence: conf } : {}),
    };
  });
}
const partial = (id: string, lang: string, text: string, stable: number): TxResult => ({
  ResultId: id, IsPartial: true, LanguageCode: lang, Alternatives: [{ Transcript: text, Items: items(text, stable, undefined, baseOf(id)) }],
});
const final = (id: string, lang: string, text: string, conf = 0.95): TxResult => {
  const its = items(text, 0, conf, baseOf(id));
  return { ResultId: id, IsPartial: false, LanguageCode: lang, StartTime: 0, EndTime: its.length * 0.4, Alternatives: [{ Transcript: text, Items: its }] };
};

interface Rec { words: string[]; retracted: string[]; calls: number }
function setup(opts: SegmenterOptions, mode: "langid" | "off" = "langid", throwing = false) {
  bases.clear();
  const chunks: Chunk[] = [];
  const rec: Rec = { words: [], retracted: [], calls: 0 };
  const tap: SegmenterTap = {
    onWords: (b) => {
      rec.calls++;
      if (throwing) throw new Error("tap bug");
      for (const t of b.tokens) rec.words.push(t.content);
    },
    onRetract: (id) => {
      rec.retracted.push(id);
    },
  };
  const seg = new Segmenter(opts, (c) => chunks.push(c), tap);
  const sink = createResultSink(mode, seg, GATE, () => 0);
  return { seg, sink, chunks, rec };
}
const quiet = <T>(fn: () => T): T => {
  const a = mock.method(console, "log", () => {});
  const b = mock.method(console, "error", () => {});
  try { return fn(); } finally { a.mock.restore(); b.mock.restore(); }
};
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/ ([.,?!;:])/g, "$1").trim();

function growing(sink: { onResult(r: TxResult, n: number): void }, id: string, text: string, t = 0): number {
  const w = text.split(" ");
  for (let n = 1; n <= w.length; n++) {
    sink.onResult(partial(id, "en-US", w.slice(0, n).join(" "), Math.max(0, n - 2)), t);
    t += 100;
  }
  return t;
}
const TEXT = "we are building a new service for live video , and it runs in the cloud every day for customers . it is fast .";

for (const [name, opts, mode] of [
  ["clause + gate", MERGE, "langid"],
  ["sentence + gate", SENTENCE, "langid"],
  ["clause, LANGUAGE_FILTER=off", MERGE, "off"],
] as const) {
  test(`tap words equal chunk words, in order, exactly once (${name})`, () => {
    const { sink, chunks, rec } = setup(opts, mode);
    quiet(() => {
      growing(sink, "r1", TEXT);
      sink.onResult(final("r1", "en-US", TEXT), 9000);
      sink.endOfStream("eof", 9500);
    });
    assert.ok(chunks.length > 0);
    assert.equal(norm(rec.words.join(" ")), norm(chunks.map((c) => c.english).join(" ")));
    assert.equal(norm(rec.words.join(" ")), norm(TEXT));
  });
}

test("final shorter than committed (carry) and repeats do not duplicate or lose words", () => {
  const { sink, chunks, rec } = setup(MERGE);
  quiet(() => {
    const t1 = "we are building a new service for live video , and it runs in the cloud .";
    growing(sink, "r1", t1);
    sink.onResult(final("r1", "en-US", "we are building a new service for live video , and it runs in the cloud ."), 5000);
    const t2 = "then we scale it out to many regions around the world .";
    growing(sink, "r2", t2, 6000);
    sink.onResult(final("r2", "en-US", t2), 9000);
    sink.endOfStream("eof", 9500);
  });
  assert.equal(norm(rec.words.join(" ")), norm(chunks.map((c) => c.english).join(" ")));
});

test("unsettled non-English result produces no tap event", () => {
  const { sink, rec } = setup(MERGE);
  quiet(() => {
    sink.onResult(partial("j1", "ja-JP", "konnichiwa minna san", 3), 0);
    sink.onResult(partial("e1", "en-US", "so um", 1), 100);
    sink.onResult(final("j1", "ja-JP", "konnichiwa minna san ."), 200);
  });
  assert.equal(rec.calls, 0);
  assert.equal(rec.retracted.length, 0);
});

test("late flip: appends, then exactly one retract; chunk behaviour unchanged", () => {
  const withTap = setup(MERGE);
  const run = (s: ReturnType<typeof setup>) =>
    quiet(() => {
      growing(s.sink, "r1", "this is some mistaken text that looks english but is not really");
      s.sink.onResult(final("r1", "ja-JP", "this is some mistaken text that looks english but is not really ."), 5000);
      s.sink.endOfStream("eof", 6000);
    });
  run(withTap);
  assert.ok(withTap.rec.calls > 0);
  assert.deepEqual(withTap.rec.retracted, ["r1"]);
  // same run without a tap gives the same chunks
  bases.clear();
  const plainChunks: Chunk[] = [];
  const seg = new Segmenter(MERGE, (c) => plainChunks.push(c));
  const sink = new LanguageGate(GATE, seg, () => 0);
  quiet(() => {
    growing(sink, "r1", "this is some mistaken text that looks english but is not really");
    sink.onResult(final("r1", "ja-JP", "this is some mistaken text that looks english but is not really ."), 5000);
    sink.endOfStream("eof", 6000);
  });
  assert.deepEqual(withTap.chunks.map((c) => c.english), plainChunks.map((c) => c.english));
});

test("a throwing tap does not change the chunks", () => {
  const run = (throwing: boolean) => {
    const s = setup(MERGE, "langid", throwing);
    quiet(() => {
      growing(s.sink, "r1", TEXT);
      s.sink.onResult(final("r1", "en-US", TEXT), 9000);
      s.sink.endOfStream("eof", 9500);
    });
    return s.chunks.map((c) => `${c.reason}|${c.english}`);
  };
  assert.deepEqual(run(true), run(false));
});
