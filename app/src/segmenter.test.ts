// Unit tests for the Segmenter (node:test). Run: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Segmenter, type Chunk, type SegmenterOptions, type TxItem, type TxResult } from "./segmenter.js";
import { BaselineSegmenter } from "./segmenter-baseline.test.js";
import { MergeBaselineSegmenter } from "./segmenter-merge-baseline.test.js";

const CONJ = ["and", "but", "so", "because", "which", "who", "where", "when", "while", "although", "though", "if", "unless", "or", "then"];
const CLAUSE: SegmenterOptions = {
  mode: "clause", minWords: 5, maxWords: 14, maxMs: 3000, pauseMs: 1200, conjunctions: CONJ,
  mergeShort: false, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000,
};
const SENTENCE: SegmenterOptions = { ...CLAUSE, mode: "sentence" };
// Deployed values, merge on.
const DEPLOYED_CONJ = ["because", "but", "although", "though", "while", "which"];
const MERGE: SegmenterOptions = { ...CLAUSE, minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900, conjunctions: DEPLOYED_CONJ, mergeShort: true };

// Build items from a string like "Hello world , this is ." ; tokens of only punctuation are punctuation.
function items(text: string, stableCount = Infinity): TxItem[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((c, i) => ({
      Content: c,
      Type: /^[.,?!;:]$/.test(c) ? "punctuation" : "pronunciation",
      Stable: i < stableCount,
      StartTime: i * 0.4,
      EndTime: i * 0.4 + 0.3,
    }));
}
function partial(id: string, text: string, stable: number): TxResult {
  return { ResultId: id, IsPartial: true, Alternatives: [{ Items: items(text, stable) }] };
}
function final(id: string, text: string): TxResult {
  return { ResultId: id, IsPartial: false, Alternatives: [{ Items: items(text, 0) }] };
}
function make(opts: SegmenterOptions = CLAUSE): { seg: Segmenter; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  return { seg: new Segmenter(opts, (c) => chunks.push(c)), chunks };
}
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/ ([.,?!;:])/g, "$1").trim();
const joined = (chunks: Chunk[]) => norm(chunks.map((c) => c.english).join(" "));

test("stable growth over several partials: no duplicate or missing tokens", () => {
  const { seg, chunks } = make();
  const full = "we are building a new service for live video , and it runs in the cloud every day for customers .";
  const words = full.split(" ");
  for (let n = 1; n <= words.length; n++) {
    seg.onResult(partial("r1", words.slice(0, n).join(" "), Math.max(0, n - 2)), n * 100);
  }
  seg.onResult(final("r1", full), 10_000);
  assert.equal(joined(chunks), norm(full));
  assert.ok(chunks.length >= 2, "expected mid-sentence chunks");
  assert.ok(chunks.slice(0, -1).every((c) => c.reason !== "final"));
});

test("stable prefix shrink is a no-op", () => {
  const { seg, chunks } = make({ ...CLAUSE, minWords: 1 });
  seg.onResult(partial("r1", "one two three four five six , x", 7), 0);
  const before = chunks.length;
  seg.onResult(partial("r1", "one two three four five six , x", 3), 100);
  assert.equal(chunks.length, before);
  seg.onResult(final("r1", "one two three four five six , x ."), 200);
  assert.equal(joined(chunks), "one two three four five six, x.");
});

test("final commits only the not-yet-committed remainder", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "the models can provide more relevant , more accurate", 7), 0);
  seg.onResult(final("r1", "the models can provide more relevant , more accurate results ."), 500);
  assert.deepEqual(chunks.map((c) => c.english), ["the models can provide more relevant,", "more accurate results."]);
  assert.equal(chunks[1].reason, "sentence"); // remainder ends with "." → sentence cut inside the final
});

test("final remainder without punctuation is flushed with reason=final", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "one two three four", 2), 0);
  seg.onResult(final("r1", "one two three four"), 100);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["one two three four", "final"]]);
});

test("comma cut honours min words", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "first , we have a really big announcement , today x", 11), 0);
  assert.deepEqual(chunks.map((c) => c.english), ["first, we have a really big announcement,"]);
  assert.equal(chunks[0].reason, "comma");
});

test('"So, um, if" is not cut (fillers do not count as words)', () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "so , um , uh , if you want x", 10), 0);
  assert.equal(chunks.length, 0);
});

test("conjunction cut happens before the conjunction", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "we launched the new feature last year because customers asked x", 11), 0);
  assert.deepEqual(chunks.map((c) => c.english), ["we launched the new feature last year"]);
  assert.equal(chunks[0].reason, "conj");
  seg.onResult(final("r1", "we launched the new feature last year because customers asked x ."), 100);
  assert.equal(chunks[1].english, "because customers asked x.");
});

test("max_words cut", () => {
  const { seg, chunks } = make({ ...CLAUSE, maxWords: 6 });
  seg.onResult(partial("r1", "a1 a2 a3 a4 a5 a6 a7 a8 x", 8), 0);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["a1 a2 a3 a4 a5 a6", "max_words"]]);
});

test("max_time and pause via tick", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "one two three four five six x", 6), 0);
  seg.tick(1000);
  assert.equal(chunks.length, 0);
  // keep activity alive so pause does not fire, then exceed maxMs
  seg.onResult(partial("r1", "one two three four five six y", 6), 2900);
  seg.tick(3000);
  assert.deepEqual(chunks.map((c) => c.reason), ["max_time"]);
  // pause: fewer than min words, but no activity for pauseMs
  seg.onResult(partial("r1", "one two three four five six seven eight z", 8), 3100);
  seg.tick(3100 + 1199);
  assert.equal(chunks.length, 1);
  seg.tick(3100 + 1200);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["one two three four five six", "max_time"], ["seven eight", "pause"]]);
  seg.onResult(final("r1", "one two three four five six seven eight z ."), 5000);
  assert.equal(joined(chunks), "one two three four five six seven eight z.");
});

test("sentence mode ignores commas and conjunctions", () => {
  const { seg, chunks } = make(SENTENCE);
  seg.onResult(partial("r1", "first , we have a really big announcement , and because of that we x", 14), 0);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r1", "first , we have a really big announcement , and because of that we did it . next"), 100);
  assert.deepEqual(chunks.map((c) => c.reason), ["sentence", "final"]);
  assert.equal(chunks[0].english, "first, we have a really big announcement, and because of that we did it.");
});

test("endOfStream commits the unstable tail", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "this is the end of the stream here", 3), 0);
  seg.endOfStream("eof", 100);
  assert.equal(joined(chunks), "this is the end of the stream here");
  assert.equal(chunks[chunks.length - 1].reason, "eof");
});

test("punctuation-only chunk is suppressed", () => {
  const { seg, chunks } = make({ ...CLAUSE, minWords: 1 });
  seg.onResult(partial("r1", "hello world x", 2), 0);
  seg.tick(5000); // pause flush "hello world"
  seg.onResult(final("r1", "hello world ."), 5100);
  assert.deepEqual(chunks.map((c) => c.english), ["hello world"]);
});

test("a mid-batch sentence end is found (regression: last-char-only check)", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "this is verticalization . We have x", 6), 0);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["this is verticalization.", "sentence"]]);
});

test("sequential results keep order and do not mix", () => {
  const { seg, chunks } = make();
  seg.onResult(partial("r1", "alpha beta gamma delta", 2), 0);
  seg.onResult(final("r1", "alpha beta gamma delta ."), 100);
  seg.onResult(partial("r2", "epsilon zeta eta theta iota", 3), 200);
  seg.onResult(final("r2", "epsilon zeta eta theta iota ."), 300);
  assert.deepEqual(chunks.map((c) => [c.english, c.resultId]), [["alpha beta gamma delta.", "r1"], ["epsilon zeta eta theta iota.", "r2"]]);
});

// ───────────────────────── merge short sentences (MERGE_SHORT) ─────────────────────────

// Capture log lines (log.ts writes "<ts> LEVEL" then the message via console.log/console.error).
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
const verifyLines = (lines: string[]) => lines.filter((l) => l.startsWith("[verify]"));

// Seeded PRNG (mulberry32).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stream {
  events: { t: number; r: TxResult }[];
  end: number;
  endReason: "eof" | "error";
  finals: number; // number of final results
  expectedWords: string[]; // all words that must come out, in order (finals + open tail)
}

// Transcribe-like stream: several results; partials with a growing (sometimes repeated or
// shrinking) stable prefix and a changing unstable tail; sentence/comma punctuation, fillers,
// lowercase words after periods, conjunctions; finals with/without trailing punctuation;
// gaps up to 3 s, unstable-only churn (exercises merge_hold); the last result may stay open.
function genStream(seed: number): Stream {
  const rnd = mulberry32(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const LOWER = ["we", "are", "building", "a", "new", "service", "for", "live", "video", "the", "models", "can", "provide", "more", "relevant", "results", "customers", "cloud", "today", "this", "is", "roadmap"];
  const CAPS = ["Yeah", "Okay", "So", "James", "This", "We", "But", "And", "Right"];
  const FILL = ["um", "uh", "hmm"];
  const CONJS = ["and", "but", "because", "which", "so", "while", "though"];
  const word = (w: string, a: number): TxItem => ({ Content: w, Type: "pronunciation", StartTime: a, EndTime: a + 0.3 });
  const punct = (p: string, a: number): TxItem => ({ Content: p, Type: "punctuation", StartTime: a, EndTime: a });
  const dt = () => 50 + rnd() * 350 + (rnd() < 0.1 ? 1000 + rnd() * 2000 : 0);
  const events: Stream["events"] = [];
  const expectedWords: string[] = [];
  let t = 0;
  let audio = 0;
  let finals = 0;
  const nResults = 2 + Math.floor(rnd() * 7);
  for (let k = 0; k < nResults; k++) {
    const id = `s${seed}r${k}`;
    const n = 1 + Math.floor(rnd() * 24);
    const toks: TxItem[] = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const w = r < 0.08 ? pick(FILL) : r < 0.18 ? pick(CONJS) : r < 0.3 ? pick(CAPS) : pick(LOWER);
      toks.push(word(w, audio));
      audio += 0.35;
      const p = rnd();
      if (i < n - 1 && p < 0.12) toks.push(punct(".", audio));
      else if (i < n - 1 && p < 0.14) toks.push(punct("?", audio));
      else if (i < n - 1 && p < 0.22) toks.push(punct(",", audio));
    }
    if (rnd() < 0.6) toks.push(punct(rnd() < 0.8 ? "." : "?", audio));
    const open = k === nResults - 1 && rnd() < 0.5;
    let shown = 0;
    let stable = 0;
    let lastItems: TxItem[] = [];
    const push = (its: TxItem[]) => {
      t += dt();
      lastItems = its;
      events.push({ t, r: { ResultId: id, IsPartial: true, Alternatives: [{ Items: its }] } });
    };
    while (shown < toks.length) {
      shown = Math.min(toks.length, shown + 1 + Math.floor(rnd() * 3));
      stable = Math.max(0, Math.min(shown, stable + Math.floor(rnd() * 4) - 1));
      if (rnd() < 0.05) stable = Math.max(0, stable - 3); // stable prefix shrink (no-op)
      const its = toks.slice(0, shown).map((it, i) => ({ ...it, Stable: i < stable }));
      push(its);
      if (rnd() < 0.15) push(its); // repeated identical partial
      if (rnd() < 0.05) {
        // unstable-only churn for ~7 s: activity without new stable words
        for (let c = 0; c < 35; c++) {
          const extra: TxItem = { Content: c % 2 ? "zzz" : "yyy", Type: "pronunciation", Stable: false, StartTime: audio, EndTime: audio + 0.3 };
          lastItems = [...its, extra];
          t += 200;
          events.push({ t, r: { ResultId: id, IsPartial: true, Alternatives: [{ Items: lastItems }] } });
        }
      }
    }
    if (open) {
      for (const it of lastItems) if (it.Type !== "punctuation") expectedWords.push(it.Content as string);
    } else {
      t += dt();
      events.push({ t, r: { ResultId: id, IsPartial: false, Alternatives: [{ Items: toks.map((it) => ({ ...it, Stable: false })) }] } });
      finals++;
      for (const it of toks) if (it.Type !== "punctuation") expectedWords.push(it.Content as string);
    }
  }
  return { events, end: t + dt(), endReason: rnd() < 0.5 ? "eof" : "error", finals, expectedWords };
}

interface SegLike {
  onResult(r: TxResult, now: number): void;
  tick(now: number): void;
  endOfStream(reason: "eof" | "error", now: number): void;
}
// Drive a segmenter like pipeline.ts: tick every 200 ms, results in between, endOfStream at the end.
function drive(seg: SegLike, s: Stream, afterTick?: (now: number) => void): void {
  let now = 0;
  for (const ev of s.events) {
    while (now + 200 <= ev.t) {
      now += 200;
      seg.tick(now);
      afterTick?.(now);
    }
    seg.onResult(ev.r, ev.t);
  }
  while (now + 200 <= s.end) {
    now += 200;
    seg.tick(now);
    afterTick?.(now);
  }
  seg.endOfStream(s.endReason, s.end);
}
function runNew(opts: SegmenterOptions, s: Stream): { chunks: Chunk[]; lines: string[] } {
  const chunks: Chunk[] = [];
  const { lines } = captureLogs(() => drive(new Segmenter(opts, (c) => chunks.push(c)), s));
  return { chunks, lines };
}
function runBaseline(opts: SegmenterOptions, s: Stream): { chunks: Chunk[]; lines: string[] } {
  const chunks: Chunk[] = [];
  const { lines } = captureLogs(() => drive(new BaselineSegmenter(opts, (c) => chunks.push(c as Chunk)), s));
  return { chunks, lines };
}
const FUZZ_SEEDS = Array.from({ length: 300 }, (_, i) => 1000 + i);

test("MERGE_SHORT=off: identical chunks and logs as the pre-merge segmenter (fuzz, 300 streams)", () => {
  let total = 0;
  for (const seed of FUZZ_SEEDS) {
    const s = genStream(seed);
    for (const opts of [CLAUSE, { ...MERGE, mergeShort: false }]) {
      const a = runBaseline(opts, s);
      const b = runNew(opts, s);
      assert.deepStrictEqual(b.chunks, a.chunks, `seed ${seed}`);
      assert.deepStrictEqual(b.lines, a.lines, `seed ${seed} logs`);
      total += a.chunks.length;
    }
  }
  assert.ok(total > 1000, `fuzz produced too few chunks (${total})`);
});

test("sentence mode ignores MERGE_SHORT=on (fuzz parity with the pre-merge segmenter)", () => {
  for (const seed of FUZZ_SEEDS) {
    const s = genStream(seed);
    const a = runBaseline(SENTENCE, s);
    const b = runNew({ ...SENTENCE, mergeShort: true }, s);
    assert.deepStrictEqual(b.chunks, a.chunks, `seed ${seed}`);
    assert.deepStrictEqual(b.lines, a.lines, `seed ${seed} logs`);
  }
});

test("merge: short sentence is held and joins the next result (exactly once, verify OK)", () => {
  const { seg, chunks } = make(MERGE);
  const { lines } = captureLogs(() => {
    seg.onResult(final("r1", "Yeah ."), 0);
    assert.equal(chunks.length, 0);
    seg.onResult(partial("r2", "we are building a new", 3), 100);
    assert.equal(chunks.length, 0);
    seg.onResult(final("r2", "we are building a new service for live video ."), 300);
    seg.tick(10_000);
    seg.endOfStream("eof", 10_100);
  });
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged, c.resultCounts]), [
    ["Yeah. we are building a new service for live video.", "sentence", 1, { r1: 2, r2: 10 }],
  ]);
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.ok(v.every((l) => l.includes(" OK ")), v.join("\n"));
  assert.match(v[0], /result=r1 items=2 committed=2 held=2 OK/);
  assert.match(v[1], /result=r2 items=10 committed=10 OK/);
  assert.equal(seg.pendingTokens, 0);
});

test("merge: short final without a period is held", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "The"), 0);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r2", "new feature is great for our media customers ."), 200);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [["The new feature is great for our media customers.", "sentence", 1]]);
});

test("merge: several short sentences keep holding until sentenceMinWords; internal periods kept", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "James ."), 0);
  seg.onResult(final("r2", "Like I , I would say ."), 300);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r3", "this is the roadmap for next year ."), 600);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [
    ["James. Like I, I would say. this is the roadmap for next year.", "sentence", 2],
  ]);
});

test("merge: a long sentence is cut immediately and carries no merged field", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(partial("r1", "we are building a new service for live video . x", 10), 0);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["we are building a new service for live video.", "sentence"]]);
  assert.ok(!("merged" in chunks[0]));
});

test("merge: pause commit (merge_pause replaces the regular pause while holding)", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "Yeah ."), 0);
  seg.tick(899);
  seg.tick(1000); // regular pauseMs=900 would have fired here
  seg.tick(1499);
  assert.equal(chunks.length, 0);
  assert.equal(seg.holdAgeMs(1499), 1499);
  seg.tick(1500);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [["Yeah.", "merge_pause", 1]]);
  assert.equal(seg.pendingTokens, 0);
  assert.equal(seg.holdAgeMs(1600), 0);
});

test("merge: hold timeout (merge_hold) while unstable activity continues; next final not duplicated", () => {
  const { seg, chunks } = make(MERGE);
  const { lines } = captureLogs(() => {
    seg.onResult(final("r1", "Yeah ."), 0);
    for (let t = 100; t <= 5900; t += 200) {
      seg.onResult(partial("r2", t % 400 === 100 ? "so we" : "so me", 0), t);
      if (t + 100 <= 5800) seg.tick(t + 100);
    }
    assert.equal(chunks.length, 0);
    seg.tick(5999);
    assert.equal(chunks.length, 0);
    seg.tick(6000);
    assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["Yeah.", "merge_hold"]]);
    seg.onResult(final("r2", "so we are building a new service for live video ."), 6100);
  });
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.resultCounts]), [
    ["Yeah.", "merge_hold", { r1: 2 }],
    ["so we are building a new service for live video.", "sentence", { r2: 11 }],
  ]);
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.ok(v.every((l) => l.includes(" OK ")), v.join("\n"));
});

test("merge: max_words cap releases held text", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "Yeah okay right ."), 0);
  const words = Array.from({ length: 25 }, (_, i) => `w${i + 1}`).join(" ");
  seg.onResult(partial("r2", words, 25), 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "max_words");
  assert.equal(chunks[0].words, 22);
  assert.equal(chunks[0].merged, 1);
  assert.ok(chunks[0].english.startsWith("Yeah okay right. w1 "), chunks[0].english);
});

test("merge: comma cut releases held text (held words count toward minWords)", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "Yeah ."), 0);
  seg.onResult(partial("r2", "so we have built many new things , and more", 10), 100);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [["Yeah. so we have built many new things,", "comma", 1]]);
});

for (const reason of ["eof", "error"] as const) {
  test(`merge: endOfStream(${reason}) flushes held text and the unstable tail`, () => {
    const { seg, chunks } = make(MERGE);
    seg.onResult(final("r1", "Okay ."), 0);
    seg.onResult(partial("r2", "so this is", 0), 100);
    seg.endOfStream(reason, 200);
    assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["Okay. so this is", reason]]);
    assert.equal(seg.pendingTokens, 0);
  });
}

test("merge: period followed by a lowercase word is not a sentence end", () => {
  // lowercase conjunction after the period → no sentence cut; the conj rule cuts before "but"
  let m = make(MERGE);
  m.seg.onResult(partial("r1", "we have nine words in this first clause . but then more", 12), 0);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["we have nine words in this first clause.", "conj"]]);
  // lowercase non-conjunction → no cut at all yet
  m = make(MERGE);
  m.seg.onResult(partial("r1", "we have nine words in this first clause . and then more", 12), 0);
  assert.equal(m.chunks.length, 0);
  // capitalised next word → real sentence end
  m = make(MERGE);
  m.seg.onResult(partial("r1", "we have nine words in this first clause . And then more", 12), 0);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["we have nine words in this first clause.", "sentence"]]);
  // merge off → unchanged behaviour (sentence cut)
  m = make({ ...MERGE, mergeShort: false });
  m.seg.onResult(partial("r1", "we have nine words in this first clause . and then more", 12), 0);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["we have nine words in this first clause.", "sentence"]]);
});

test("merge: filler-only final is held and fillers don't count toward sentenceMinWords", () => {
  const { seg, chunks } = make(MERGE);
  seg.onResult(final("r1", "Um ."), 0);
  seg.onResult(final("r2", "um uh this is a short one ."), 200); // 5 words (+ fillers)
  assert.equal(chunks.length, 0);
  seg.onResult(final("r3", "and it is fine ."), 400); // 9 words total
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.words, c.merged]), [
    ["Um. um uh this is a short one. and it is fine.", "sentence", 9, 2],
  ]);
});

test("merge on: exactly-once, verify OK, nothing left, bounded hold age (fuzz, 300 streams)", () => {
  const stats: Record<string, number> = {};
  let merged = 0;
  for (const seed of FUZZ_SEEDS) {
    const s = genStream(seed);
    const chunks: Chunk[] = [];
    const seg = new Segmenter(MERGE, (c) => chunks.push(c));
    const { lines } = captureLogs(() =>
      drive(seg, s, (now) => {
        const age = seg.holdAgeMs(now);
        assert.ok(age < MERGE.mergeMaxHoldMs + 200, `seed ${seed}: held ${age} ms at ${now}`);
      }),
    );
    const got = chunks.flatMap((c) => c.english.split(" ").map((w) => w.replace(/[.,?!;:]/g, "")).filter(Boolean));
    assert.deepStrictEqual(got, s.expectedWords, `seed ${seed}: words lost or duplicated`);
    const v = verifyLines(lines);
    assert.equal(v.length, s.finals, `seed ${seed}: verify lines`);
    assert.ok(v.every((l) => / OK /.test(l)), `seed ${seed}:\n${v.join("\n")}`);
    assert.equal(seg.pendingTokens, 0, `seed ${seed}: pending left`);
    assert.equal(seg.holdAgeMs(s.end), 0);
    for (const c of chunks) {
      stats[c.reason] = (stats[c.reason] ?? 0) + 1;
      merged += c.merged ?? 0;
    }
  }
  // The fuzz must actually exercise the merge paths.
  assert.ok(merged > 50, `merged=${merged}`);
  assert.ok((stats.merge_pause ?? 0) > 0, JSON.stringify(stats));
  assert.ok((stats.merge_hold ?? 0) > 0, JSON.stringify(stats));
});

// ───────────────────────── complete-sentence release (sentenceCompleteWords) ─────────────────────────

const COMPLETE: SegmenterOptions = { ...MERGE, sentenceCompleteWords: 5 };

function runMergeBaseline(opts: SegmenterOptions, s: Stream): { chunks: Chunk[]; lines: string[] } {
  const chunks: Chunk[] = [];
  const { lines } = captureLogs(() => drive(new MergeBaselineSegmenter(opts, (c) => chunks.push(c)), s));
  return { chunks, lines };
}

test("SENTENCE_COMPLETE_WORDS=0 / absent: identical chunks and logs as the pre-change merge segmenter (fuzz, 300 streams)", () => {
  let total = 0;
  const { sentenceCompleteWords: _drop, ...absent } = COMPLETE;
  for (const seed of FUZZ_SEEDS) {
    const s = genStream(seed);
    const a = runMergeBaseline(MERGE, s);
    for (const opts of [{ ...MERGE, sentenceCompleteWords: 0 }, absent as SegmenterOptions]) {
      const b = runNew(opts, s);
      assert.deepStrictEqual(b.chunks, a.chunks, `seed ${seed}`);
      assert.deepStrictEqual(b.lines, a.lines, `seed ${seed} logs`);
    }
    total += a.chunks.length;
  }
  assert.ok(total > 500, `fuzz produced too few chunks (${total})`);
});

test("complete-sentence release on: exactly-once, verify OK, nothing left, bounded hold age (fuzz, 300 streams)", () => {
  const stats: Record<string, number> = {};
  let merged = 0;
  let released = 0; // short sentence chunks that the old rule would have held
  for (const seed of FUZZ_SEEDS) {
    const s = genStream(seed);
    const chunks: Chunk[] = [];
    const seg = new Segmenter(COMPLETE, (c) => chunks.push(c));
    const { lines } = captureLogs(() =>
      drive(seg, s, (now) => {
        const age = seg.holdAgeMs(now);
        assert.ok(age < COMPLETE.mergeMaxHoldMs + 200, `seed ${seed}: held ${age} ms at ${now}`);
      }),
    );
    const got = chunks.flatMap((c) => c.english.split(" ").map((w) => w.replace(/[.,?!;:]/g, "")).filter(Boolean));
    assert.deepStrictEqual(got, s.expectedWords, `seed ${seed}: words lost or duplicated`);
    const v = verifyLines(lines);
    assert.equal(v.length, s.finals, `seed ${seed}: verify lines`);
    assert.ok(v.every((l) => / OK /.test(l)), `seed ${seed}:\n${v.join("\n")}`);
    assert.equal(seg.pendingTokens, 0, `seed ${seed}: pending left`);
    assert.equal(seg.holdAgeMs(s.end), 0);
    for (const c of chunks) {
      stats[c.reason] = (stats[c.reason] ?? 0) + 1;
      merged += c.merged ?? 0;
      if (c.reason === "sentence" && c.words < COMPLETE.sentenceMinWords) released++;
    }
  }
  assert.ok(released > 0, `F2 never fired ${JSON.stringify(stats)}`);
  assert.ok(merged > 50, `merged=${merged}`);
  assert.ok((stats.merge_pause ?? 0) > 0, JSON.stringify(stats));
  assert.ok((stats.merge_hold ?? 0) > 0, JSON.stringify(stats));
});

test("complete: a sentence split across two finals is cut at the second final (no merge_pause wait)", () => {
  // chunk 91 / "We have about" + "10 minutes." in the user's run
  let m = make(COMPLETE);
  m.seg.onResult(final("r1", "We have about"), 0);
  assert.equal(m.chunks.length, 0);
  m.seg.onResult(final("r2", "10 minutes ."), 300);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason, c.merged, c.committedAt]), [["We have about 10 minutes.", "sentence", 1, 300]]);
  // cw 0 (today): held until merge_pause
  m = make(MERGE);
  m.seg.onResult(final("r1", "We have about"), 0);
  m.seg.onResult(final("r2", "10 minutes ."), 300);
  assert.equal(m.chunks.length, 0);
  m.seg.tick(1800);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["We have about 10 minutes.", "merge_pause"]]);
});

test("complete: a stable 7-word question is cut immediately", () => {
  const { seg, chunks } = make(COMPLETE);
  seg.onResult(partial("r1", "Is that a function you use today ? X", 8), 0);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["Is that a function you use today?", "sentence"]]);
  assert.ok(!("merged" in chunks[0]));
});

test("complete: a fragment is still held and joins the next complete sentence", () => {
  const { seg, chunks } = make(COMPLETE);
  seg.onResult(final("r1", "I see ."), 0);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r2", "We have about 10 minutes ."), 200);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [["I see. We have about 10 minutes.", "sentence", 1]]);
});

test("complete: sentences below sentenceCompleteWords are held (fillers don't count)", () => {
  let m = make(COMPLETE);
  m.seg.onResult(final("r1", "Thank you very much ."), 0);
  assert.equal(m.chunks.length, 0);
  m = make(COMPLETE);
  m.seg.onResult(final("r1", "Um , this is it ."), 0);
  assert.equal(m.chunks.length, 0);
  // the count restarts after a held sentence end: "OK." (1) + "Thank you very much." (4) stays held
  m = make(COMPLETE);
  m.seg.onResult(final("r1", "OK . Thank you very much ."), 0);
  assert.equal(m.chunks.length, 0);
  m.seg.tick(1500);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["OK. Thank you very much.", "merge_pause"]]);
});

test("complete: a false sentence end (lowercase next word) is not released", () => {
  const { seg, chunks } = make(COMPLETE);
  seg.onResult(partial("r1", "these are five short words . and more", 8), 0);
  assert.equal(chunks.length, 0);
});

test("complete: the short tail of a sentence cut mid-way is not held (comma cut / final split)", () => {
  // comma cut after 9 words, then the 2-word tail ends the sentence
  let m = make(COMPLETE);
  m.seg.onResult(partial("r1", "So the router is fully backward compatible with all , the existing services . X", 14), 0);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [
    ["So the router is fully backward compatible with all,", "comma"],
    ["the existing services.", "sentence"],
  ]);
  // Transcribe final split mid-sentence (flushed with reason=final), tail in the next result
  m = make(COMPLETE);
  m.seg.onResult(final("r1", "So the router is fully backward compatible with the"), 0);
  m.seg.onResult(final("r2", "existing services ."), 400);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason, c.committedAt]), [
    ["So the router is fully backward compatible with the", "final", 0],
    ["existing services.", "sentence", 400],
  ]);
  // cw 0 (today): the tail waits for merge_pause
  m = make(MERGE);
  m.seg.onResult(final("r1", "So the router is fully backward compatible with the"), 0);
  m.seg.onResult(final("r2", "existing services ."), 400);
  assert.equal(m.chunks.length, 1);
  m.seg.tick(1900);
  assert.deepEqual(m.chunks.map((c) => c.reason), ["final", "merge_pause"]);
  // the pause rule cuts mid-sentence ("We have about" | "10 minutes." in a J2 capture): the tail
  // counts the words before the pause and is cut at once
  m = make(COMPLETE);
  m.seg.onResult(partial("r1", "We have about x", 3), 0);
  m.seg.tick(1000); // pauseMs 900
  assert.deepEqual(m.chunks.map((c) => c.reason), ["pause"]);
  m.seg.onResult(final("r1", "We have about 10 minutes ."), 1100);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [
    ["We have about", "pause"],
    ["10 minutes.", "sentence"],
  ]);
  // a hold release (merge_pause) starts fresh: a 1-word remainder after it is still held
  m = make(COMPLETE);
  m.seg.onResult(final("r1", "So the router is"), 0);
  m.seg.tick(1500);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [["So the router is", "merge_pause"]]);
  m.seg.onResult(final("r2", "fine ."), 1600);
  assert.equal(m.chunks.length, 1);
  m.seg.tick(3100);
  assert.deepEqual(m.chunks.map((c) => [c.english, c.reason]), [
    ["So the router is", "merge_pause"],
    ["fine.", "merge_pause"],
  ]);
  // a fragment after a sentence that ended with .?! is still held
  m = make(COMPLETE);
  m.seg.onResult(final("r1", "So the router is fully backward compatible with them ."), 0);
  m.seg.onResult(final("r2", "I see ."), 400);
  assert.equal(m.chunks.length, 1);
});

test("complete: 'OK. I think now we can take some questions.' is one chunk", () => {
  const { seg, chunks } = make(COMPLETE);
  seg.onResult(partial("r1", "OK . I think now we can take some questions . We have about", 12), 0);
  assert.deepEqual(chunks.map((c) => [c.english, c.reason, c.merged]), [["OK. I think now we can take some questions.", "sentence", 1]]);
});

// ───────────────────────── language gate hooks (closeResult / noteActivity) ─────────────────────────

test("closeResult removes un-emitted tokens, keeps emitted chunks, logs LANGDROP not MISMATCH", () => {
  const { seg, chunks } = make(MERGE);
  const { lines } = captureLogs(() => {
    // 10 stable words with a comma after 8 → one chunk emitted, 2 words left in pending.
    seg.onResult(partial("r1", "one two three four five six seven eight , nine ten x", 11), 0);
    assert.deepEqual(chunks.map((c) => c.english), ["one two three four five six seven eight,"]);
    seg.closeResult("r1", "ja-JP", 100);
    // Other results keep working; nothing of r1 comes out later.
    seg.onResult(final("r2", "a completely different english sentence that is long enough ."), 200);
    seg.tick(10_000);
    seg.endOfStream("eof", 20_000);
  });
  assert.deepEqual(chunks.map((c) => c.english), [
    "one two three four five six seven eight,",
    "a completely different english sentence that is long enough.",
  ]);
  const v = verifyLines(lines);
  assert.equal(v.length, 2);
  assert.match(v[0], /result=r1 committed=11 emitted=9 removed=2 LANGDROP lang=ja-JP/);
  assert.match(v[1], /result=r2 .* OK /);
  assert.ok(!v.some((l) => /MISMATCH/.test(l)));
  assert.equal(seg.pendingTokens, 0);
});

test("closeResult on an unknown/closed result is a no-op", () => {
  const { seg, chunks } = make(MERGE);
  const { lines } = captureLogs(() => seg.closeResult("nope", "ja-JP", 0));
  assert.equal(chunks.length, 0);
  assert.equal(verifyLines(lines).length, 0);
});

test("noteActivity postpones the pause flush", () => {
  const { seg, chunks } = make(CLAUSE);
  seg.onResult(partial("r1", "one two three x", 3), 0);
  seg.noteActivity(1000);
  seg.tick(1199 + 0); // 1199 ms after the partial, 199 ms after the activity
  seg.tick(2100); // 1100 ms after the activity
  assert.equal(chunks.length, 0);
  seg.tick(2200); // 1200 ms after the activity
  assert.deepEqual(chunks.map((c) => [c.english, c.reason]), [["one two three", "pause"]]);
});
