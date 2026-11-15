// Tests for quality-v1 part B in segmenter.ts: dangling-end guard (B1), look-ahead (B2),
// short-sentence join (B3) and the off-switch parity with today's options.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LanguageGate } from "../src/language-gate.js";
import { Segmenter, joinShortSentences, DEFAULT_DANGLING_WORDS, type Chunk, type SegmenterOptions, type TxItem, type TxResult } from "../src/segmenter.js";

// Deployed values (cdk/cdk.json), part B off.
const BASE: SegmenterOptions = {
  mode: "clause", minWords: 8, maxWords: 22, maxMs: 0, pauseMs: 900,
  conjunctions: ["because", "but", "although", "though", "while", "which"],
  mergeShort: true, sentenceMinWords: 8, mergePauseMs: 1500, mergeMaxHoldMs: 6000, sentenceCompleteWords: 5,
};
const GUARD: SegmenterOptions = { ...BASE, danglingGuard: true, danglingMaxWords: 4, danglingMaxHoldMs: 2000 };

function items(text: string, stableCount = Infinity, t0 = 0): TxItem[] {
  return text.split(/\s+/).filter(Boolean).map((c, i) => ({
    Content: c,
    Type: /^[.,?!;:]$/.test(c) ? "punctuation" : "pronunciation",
    Stable: i < stableCount,
    StartTime: t0 + i * 0.4,
    EndTime: t0 + i * 0.4 + 0.3,
  }));
}
const partial = (id: string, text: string, stable: number): TxResult => ({ ResultId: id, IsPartial: true, Alternatives: [{ Items: items(text, stable) }] });
const final = (id: string, text: string): TxResult => ({ ResultId: id, IsPartial: false, Alternatives: [{ Items: items(text, 0) }] });
function make(opts: SegmenterOptions): { seg: Segmenter; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  return { seg: new Segmenter(opts, (c) => chunks.push(c)), chunks };
}
function captureLogs<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => { lines.push(a.slice(1).map(String).join(" ")); };
  const l = mock.method(console, "log", rec);
  const e = mock.method(console, "error", rec);
  try { return { result: fn(), lines }; } finally { l.mock.restore(); e.mock.restore(); }
}
const verifyLines = (lines: string[]) => lines.filter((l) => l.startsWith("[verify]"));
// Run the clock in 200 ms ticks from `from` to `to` (exclusive of from).
function ticks(seg: Segmenter, from: number, to: number): void {
  for (let t = from + 200; t <= to; t += 200) seg.tick(t);
}

test("default dangling list has the documented categories", () => {
  for (const w of ["in", "within", "the", "that", "who", "and", "is", "'s", "not"]) assert.ok(DEFAULT_DANGLING_WORDS.includes(w), w);
});

// ---------- B1: findCut paths ----------
test("B1 comma after a dangling word is not a cut point", () => {
  const text = "And because this is all done in the packager in , you don't need to worry about it .";
  const off = make(BASE); off.seg.onResult(partial("r", text, 99), 0);
  assert.equal(off.chunks[0].reason, "comma");
  assert.match(off.chunks[0].english, /in,$/);
  const on = make(GUARD); on.seg.onResult(partial("r", text, 99), 0);
  assert.notEqual(on.chunks[0].reason, "comma"); // the comma after "in" is skipped, the sentence cut wins
  assert.match(on.chunks[0].english, /worry about it\.$/);
});

test("B1 conjunction cut is skipped after a dangling word", () => {
  const text = "We can reach any device with a player that is very much like the one which we use today .";
  const off = make({ ...BASE, minWords: 5 }); off.seg.onResult(partial("r", text, 99), 0);
  assert.equal(off.chunks[0].reason, "conj");
  const on = make({ ...GUARD, minWords: 5 });
  on.seg.onResult(partial("r", text, 99), 0);
  // "...like the one which": the word before "which" is "one" (not dangling), so cut stays; check a dangling case
  const dang = "We can reach any device with a player that is very much like the one that which we use today .";
  const a = make({ ...GUARD, minWords: 5 }); a.seg.onResult(partial("r", dang, 99), 0);
  assert.ok(a.chunks.every((c) => !/\bthat$/.test(c.english)), a.chunks.map((c) => c.english).join(" | "));
});

test("B1 max_words extends past the cap for a dangling word, bounded by danglingMaxWords", () => {
  const w = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const o: SegmenterOptions = { ...GUARD, minWords: 30, maxWords: 10, danglingMaxWords: 3 };
  const a = make(o);
  a.seg.onResult(partial("r", `${w(9)} of the more end`, 99), 0); // word 10 = "of" dangling, "the" dangling, "more" ok
  assert.equal(a.chunks[0].reason, "max_words");
  assert.equal(a.chunks[0].english, `${w(9)} of the more`);
  const b = make(o);
  b.seg.onResult(partial("r", `${w(9)} of the in on at x`, 99), 0); // all dangling past the cap: stops at cap+3
  assert.equal(b.chunks[0].english, `${w(9)} of the in on`);
  const off = make({ ...o, danglingGuard: false });
  off.seg.onResult(partial("r", `${w(9)} of the more`, 99), 0);
  assert.equal(off.chunks[0].english, `${w(9)} of`);
});

// ---------- B1: time / final cuts ----------
test("B1 pause deferral releases at danglingMaxHoldMs with the original reason", () => {
  const { seg, chunks } = make(GUARD);
  seg.onResult(partial("r", "Uh we support a set of six layouts in", 99), 0);
  ticks(seg, 0, 1000);
  assert.equal(chunks.length, 0); // pause (900) fires at 1000 but the tail "in" dangles: deferred until 3000
  ticks(seg, 1000, 2800);
  assert.equal(chunks.length, 0);
  ticks(seg, 2800, 3200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "pause");
  assert.match(chunks[0].english, /layouts in$/);
});

test("B1 the same pause without the guard cuts at 900 ms", () => {
  const { seg, chunks } = make(BASE);
  seg.onResult(partial("r", "Uh we support a set of six layouts in", 99), 0);
  ticks(seg, 0, 1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "pause");
});

test("B1 a deferred pause chunk merges with the text that follows", () => {
  const { seg, chunks } = make(GUARD);
  seg.onResult(partial("r", "Uh we support a set of six layouts in", 99), 0);
  ticks(seg, 0, 1000);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r", "Uh we support a set of six layouts in MediaLive ."), 1300);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].english, "Uh we support a set of six layouts in MediaLive.");
});

test("B1 final is deferred on a dangling tail and released by the next result", () => {
  const { seg, chunks } = make(GUARD);
  const { lines } = captureLogs(() => {
    seg.onResult(final("r1", "So this gives a way to minimize the cost that is needed to deliver the maximum number of"), 0);
    assert.equal(chunks.length, 0);
    seg.onResult(partial("r2", "possible multi-view experiences .", 99), 500);
  });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].english, /number of possible multi-view experiences\.$/);
  assert.ok(!verifyLines(lines).some((l) => /MISMATCH/.test(l)), lines.join("\n"));
});

test("B1 final deferral is bounded: nothing follows, released at danglingMaxHoldMs with reason final", () => {
  const { seg, chunks } = make(GUARD);
  seg.onResult(final("r1", "So this gives a way to minimize the cost that is needed to deliver the maximum number of"), 0);
  ticks(seg, 0, 1900);
  assert.equal(chunks.length, 0);
  ticks(seg, 1900, 2200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "final");
});

test("B1 merge_hold deferral on a dangling tail", () => {
  const { seg, chunks } = make({ ...GUARD, mergeMaxHoldMs: 3000, mergePauseMs: 0 });
  seg.onResult(partial("r", "Hello there . And so we go to", 99), 0); // held (short), tail "to" dangles
  ticks(seg, 0, 3600);
  assert.equal(chunks.length, 0);
  ticks(seg, 3600, 5400);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "merge_hold");
});

test("B1 end of stream never defers; a sentence end never defers", () => {
  const a = make(GUARD);
  a.seg.onResult(partial("r", "we are looking at the", 99), 0);
  a.seg.endOfStream("eof", 100);
  assert.equal(a.chunks.length, 1);
  assert.equal(a.chunks[0].reason, "eof");
  const b = make(GUARD);
  b.seg.onResult(partial("r", "Can I ask you to clarify the entitlement question ?", 99), 0);
  assert.equal(b.chunks.length, 1);
  assert.equal(b.chunks[0].reason, "sentence");
});

test("B1 apostrophe forms: you're dangles, that's does not", () => {
  const a = make(GUARD);
  a.seg.onResult(final("r1", "And it delivers those groups in the same way that you're"), 0);
  assert.equal(a.chunks.length, 0);
  const b = make(GUARD);
  b.seg.onResult(final("r1", "And it delivers those groups in the same way and that's"), 0);
  assert.equal(b.chunks.length, 1);
});

test("B1 positive case: 'pointing to' + 'the multi-view channel.' is one chunk; nothing following is bounded", () => {
  const a = make(GUARD);
  a.seg.onResult(final("r1", "the manifest URL is right here so that's pointing to"), 0);
  a.seg.onResult(final("r2", "the multi-view channel ."), 100);
  assert.equal(a.chunks.length, 1);
  assert.match(a.chunks[0].english, /pointing to the multi-view channel\.$/);
  const b = make(GUARD);
  b.seg.onResult(final("r1", "the manifest URL is right here so that's pointing to"), 0);
  ticks(b.seg, 0, 2300);
  assert.equal(b.chunks.length, 1);
});

// ---------- B2 look-ahead ----------
test("B2 look-ahead merges 'set of six' + 'different layouts.' arriving 400 ms later", () => {
  const o: SegmenterOptions = { ...BASE, cutLookaheadMs: 700 };
  const { seg, chunks } = make(o);
  seg.onResult(final("r1", "At launch we support a set of six"), 0);
  ticks(seg, 0, 400);
  assert.equal(chunks.length, 0);
  seg.onResult(final("r2", "different layouts ."), 400);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].english, "At launch we support a set of six different layouts.");
});

test("B2 look-ahead never delays a chunk beyond cutLookaheadMs", () => {
  const { seg, chunks } = make({ ...BASE, cutLookaheadMs: 700, mergeShort: false });
  seg.onResult(final("r1", "At launch we support a set of six layouts for the show today"), 0);
  assert.equal(chunks.length, 0);
  ticks(seg, 0, 600);
  assert.equal(chunks.length, 0);
  ticks(seg, 600, 800);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "final");
});

test("B2 look-ahead does not delay a .?! sentence end", () => {
  const { seg, chunks } = make({ ...BASE, cutLookaheadMs: 700 });
  seg.onResult(final("r1", "Ok I think now we can take some questions we have about ten minutes ."), 0);
  assert.equal(chunks.length, 1);
});

test("B2 finalHold variant holds a mid-sentence final like a short remainder", () => {
  const { seg, chunks } = make({ ...BASE, finalHold: true });
  seg.onResult(final("r1", "At launch we support a set of six layouts for the show today"), 0);
  assert.equal(chunks.length, 0);
  ticks(seg, 0, 1700);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "merge_pause");
});

// ---------- B3 ----------
test("joinShortSentences joins tiny sentences, keeps normal sentences", () => {
  const toks = (s: string) => s.split(/\s+/).map((c) => ({ content: c, punct: /^[.,?!]$/.test(c) }));
  assert.equal(joinShortSentences(toks("There's small . Medium ? And large ."), 3), "There's small, Medium, and large.");
  assert.equal(joinShortSentences(toks("Hello there . We do all of this at the same time ."), 3), "Hello there. We do all of this at the same time.");
  assert.equal(joinShortSentences(toks("Right . I see ."), 3), "Right, I see.");
  assert.equal(joinShortSentences(toks("Right . I see ."), 1), "Right. I see.");
  assert.equal(joinShortSentences(toks("Hello there ."), 3), "Hello there.");
});

test("B3 'There's small. Medium? And large.' held across 2.7 s and 1.5 s gaps is one chunk, verify OK", () => {
  const o: SegmenterOptions = { ...BASE, shortSentenceJoin: true, shortSentenceWords: 3, shortJoinPauseMs: 3500 };
  const { seg, chunks } = make(o);
  const { lines } = captureLogs(() => {
    seg.onResult(final("r1", "There's small ."), 0);
    ticks(seg, 0, 2700);
    assert.equal(chunks.length, 0); // 1500 ms merge pause would have released it at 1.5 s
    seg.onResult(final("r2", "Medium ?"), 2700);
    ticks(seg, 2700, 4200);
    assert.equal(chunks.length, 0);
    seg.onResult(final("r3", "And large ."), 4200);
    ticks(seg, 4200, 9000);
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].english, "There's small, Medium, and large.");
  assert.equal(chunks[0].merged, 3);
  const v = verifyLines(lines);
  assert.equal(v.length, 3);
  assert.ok(v.every((l) => / OK /.test(l)) && !v.some((l) => /MISMATCH/.test(l)), v.join("\n"));
});

test("B3 without the switch the same input releases at the normal merge pause", () => {
  const { seg, chunks } = make(BASE);
  seg.onResult(final("r1", "There's small ."), 0);
  ticks(seg, 0, 1700);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "merge_pause");
  assert.equal(chunks[0].english, "There's small.");
});

test("B3 a held segment longer than shortSentenceWords keeps the normal merge pause", () => {
  const o: SegmenterOptions = { ...BASE, shortSentenceJoin: true, shortSentenceWords: 3, shortJoinPauseMs: 3500 };
  const { seg, chunks } = make(o);
  seg.onResult(final("r1", "Ok yes that works ."), 0); // 4 words: held, not a tiny fragment
  ticks(seg, 0, 1700);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason, "merge_pause");
  const t = make(o);
  t.seg.onResult(final("r1", "Ok yes ."), 0); // 2 words: tiny fragment waits for shortJoinPauseMs
  ticks(t.seg, 0, 3000);
  assert.equal(t.chunks.length, 0);
  ticks(t.seg, 3000, 3700);
  assert.equal(t.chunks.length, 1);
});

// ---------- parity with today's options ----------
function parityRows(file: string): TxResult[] | null {
  const p = fileURLToPath(new URL(`../../../test-data/sentence-latency/${file}`, import.meta.url));
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.wall !== undefined)
    .map((r) => ({ _wall: r.wall, ResultId: r.id, IsPartial: r.partial, LanguageCode: r.lang ?? undefined, StartTime: r.start, EndTime: r.end, Alternatives: [{ Items: r.items.map((i: any[]) => ({ Content: i[0], Stable: !!i[1], Type: i[3], StartTime: i[4] ?? undefined, EndTime: i[5] ?? undefined })) }] }) as unknown as TxResult);
}
function runAll(rows: (TxResult & { _wall: number })[], opts: SegmenterOptions) {
  const chunks: Chunk[] = [];
  const seg = new Segmenter(opts, (c) => chunks.push(c));
  // the real language gate in front, as in the app (the capture mixes languages and split results)
  const gate = new LanguageGate({ source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6 }, seg, () => 0);
  let last = 0;
  const { lines } = captureLogs(() => {
    for (const r of rows) {
      for (let t = Math.floor(last / 200) * 200 + 200; t < r._wall; t += 200) seg.tick(t);
      last = r._wall;
      gate.onResult(r, r._wall);
    }
    for (let t = Math.floor(last / 200) * 200 + 200; t < last + 8000; t += 200) seg.tick(t);
    gate.endOfStream("eof", last + 8000);
  });
  return { chunks: chunks.map((c) => ({ english: c.english, reason: c.reason, words: c.words, committedAt: c.committedAt, merged: c.merged })), lines };
}
const OFF: SegmenterOptions = {
  ...BASE, danglingGuard: false, danglingMaxWords: 4, danglingMaxHoldMs: 2000, cutLookaheadMs: 0, finalHold: false,
  shortSentenceJoin: false, shortSentenceWords: 3, shortJoinPauseMs: 3500,
};

for (const file of ["e1_langid_high.jsonl", "j2_langid_high.jsonl", "e1_langid_high_burst450.jsonl", "j2_langid_high_burst450.jsonl"]) {
  test(`off-switch parity on recorded capture ${file}`, (t) => {
    const rows = parityRows(file) as (TxResult & { _wall: number })[] | null;
    if (!rows) return t.skip("capture not present");
    const a = runAll(rows, BASE), b = runAll(rows, OFF);
    assert.ok(a.chunks.length > 10);
    assert.deepEqual(b.chunks, a.chunks);
    assert.deepEqual(b.lines.filter((l) => l.startsWith("[verify]")), a.lines.filter((l) => l.startsWith("[verify]")));
    assert.ok(!a.lines.some((l) => /MISMATCH/.test(l)));
    // and with every switch on: exactly once (no MISMATCH) and the same words in the same order
    const c = runAll(rows, { ...GUARD, cutLookaheadMs: 700, shortSentenceJoin: true, shortJoinPauseMs: 3500 });
    assert.ok(!c.lines.some((l) => /MISMATCH/.test(l)), "MISMATCH with switches on");
    const words = (cs: { english: string }[]) => cs.map((x) => x.english).join(" ").toLowerCase().replace(/[.,?!]/g, "").split(/\s+/);
    assert.deepEqual(words(c.chunks), words(a.chunks));
  });
}
