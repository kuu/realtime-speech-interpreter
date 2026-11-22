// Two-lane routing: one Transcribe result stream feeds the gate of each lane (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { LanguageGate, type LanguageGateOptions, type GateSegmenter, type ResultSink } from "../src/language-gate.js";
import { LaneRouter } from "../src/lane-router.js";
import type { TxItem, TxResult } from "../src/segmenter.js";

const EN: LanguageGateOptions = { laneId: "ja", source: "en-US", settleWords: 3, shortWords: 4, shortMinConf: 0.6 };
const JA: LanguageGateOptions = { laneId: "en", source: "ja-JP", settleWords: 3, settleItems: 3, shortWords: 4, shortMinConf: 0.6 };

interface Call { kind: string; id?: string; text?: string }
class StubSegmenter implements GateSegmenter {
  calls: Call[] = [];
  emitted = 0;
  onResult(r: TxResult): void {
    this.calls.push({ kind: "result", id: r.ResultId, text: (r.Alternatives?.[0]?.Items ?? []).map((i) => i.Content).join(" ") });
  }
  noteActivity(): void {
    this.calls.push({ kind: "activity" });
  }
  closeResult(id: string) {
    this.calls.push({ kind: "close", id });
    return { emitted: this.emitted, removed: 0 };
  }
  endOfStream(): void {
    this.calls.push({ kind: "eos" });
  }
  tick(): void {}
}

let slot = 0;
const bases = new Map<string, number>();
const baseOf = (id: string) => {
  if (!bases.has(id)) bases.set(id, slot++ * 100);
  return bases.get(id) as number;
};
function toItems(tokens: string[], stable: number, id: string, conf?: number): TxItem[] {
  const b = baseOf(id);
  return tokens.map((c, i) => {
    const punct = /^[.,?!、。]$/.test(c);
    return {
      Content: c,
      Type: punct ? "punctuation" : "pronunciation",
      Stable: i < stable,
      StartTime: b + i * 0.4,
      EndTime: b + i * 0.4 + 0.3,
      ...(conf !== undefined && !punct ? { Confidence: conf } : {}),
    };
  });
}
function part(id: string, lang: string, tokens: string[], stable = tokens.length): TxResult {
  return { ResultId: id, IsPartial: true, LanguageCode: lang, Alternatives: [{ Items: toItems(tokens, stable, id) }] };
}
function fin(id: string, lang: string, tokens: string[], conf = 0.95): TxResult {
  return { ResultId: id, IsPartial: false, LanguageCode: lang, StartTime: 0, EndTime: tokens.length * 0.4, Alternatives: [{ Items: toItems(tokens, 0, id, conf) }] };
}
function setup() {
  bases.clear();
  slot = 0;
  const segEn = new StubSegmenter();
  const segJa = new StubSegmenter();
  const gEn = new LanguageGate(EN, segEn, () => 0);
  const gJa = new LanguageGate(JA, segJa, () => 0);
  const router = new LaneRouter([
    { id: "ja", sink: gEn, tick: () => segEn.tick() },
    { id: "en", sink: gJa, tick: () => segJa.tick() },
  ]);
  return { segEn, segJa, gEn, gJa, router };
}
const kinds = (s: StubSegmenter, k: string) => s.calls.filter((c) => c.kind === k);

test("an English result reaches only the English-source lane, a Japanese result only the Japanese-source lane", () => {
  const { segEn, segJa, router } = setup();
  router.onResult(part("a", "en-US", ["we", "are", "here", "today"]), 1000);
  router.onResult(part("b", "ja-JP", ["今日", "は", "晴れ", "です"]), 1100);
  assert.deepEqual(kinds(segEn, "result").map((c) => c.id), ["a"]);
  assert.deepEqual(kinds(segJa, "result").map((c) => c.id), ["b"]);
});

test("a partial tagged en-US that flips to ja-JP: lane 1 gets it only after settling, lane 2 only after the flip", () => {
  const { segEn, segJa, router } = setup();
  router.onResult(part("a", "en-US", ["so", "there"], 2), 1000); // unsettled on lane 1 (needs 3 stable)
  assert.equal(kinds(segEn, "result").length, 0);
  router.onResult(part("a", "ja-JP", ["はい", "あり", "がとう", "ござい"], 4), 1100);
  assert.equal(kinds(segEn, "result").length, 0);
  assert.equal(kinds(segJa, "result").length, 1);
  router.onResult(fin("a", "ja-JP", ["はい", "ありがとう", "ございます", "。"]), 1200);
  assert.equal(kinds(segEn, "close").length, 0, "never forwarded on lane 1, nothing to close");
});

test("late flip on lane 1 with and without an emitted chunk counts lateSpoken only when something was emitted", () => {
  const { segEn, gEn, router } = setup();
  segEn.emitted = 0;
  router.onResult(part("a", "en-US", ["we", "are", "here", "now"], 4), 1000);
  router.onResult(fin("a", "ja-JP", ["今日", "は", "晴れ"]), 1100);
  assert.equal(gEn.stats.late, 1);
  assert.equal(gEn.stats.lateSpoken, 0);
  segEn.emitted = 3;
  router.onResult(part("b", "en-US", ["and", "then", "we", "go"], 4), 2000);
  router.onResult(fin("b", "ja-JP", ["そして", "行き", "ます"]), 2100);
  assert.equal(gEn.stats.late, 2);
  assert.equal(gEn.stats.lateSpoken, 1);
  assert.equal(gEn.dropsByReason["non-english-late"], 2);
});

test("short low-confidence interjections are dropped in both directions", () => {
  const { segEn, segJa, router } = setup();
  // Lane 1: short English fragment after a Japanese final.
  router.onResult(fin("j1", "ja-JP", ["今日", "は", "晴れ", "です", "ね", "本当", "に"]), 1000);
  router.onResult(fin("e1", "en-US", ["okay", "so"], 0.4), 1100);
  assert.equal(kinds(segEn, "result").length, 0);
  // Lane 2: short Japanese fragment (<= 4 characters) after an English final.
  router.onResult(fin("e2", "en-US", ["we", "are", "here", "to", "talk", "about", "it"]), 2000);
  router.onResult(fin("j2", "ja-JP", ["はい"], 0.4), 2100);
  assert.equal(kinds(segJa, "result").filter((c) => c.id === "j2").length, 0, "short Japanese fragment dropped");
  // A long low-confidence Japanese result is kept.
  router.onResult(fin("j3", "ja-JP", ["今日", "は", "晴れ", "です"], 0.4), 2200);
  assert.equal(kinds(segJa, "result").filter((c) => c.id === "j3").length, 1);
});

test("as-said tap per lane: lane 1 shows Japanese, lane 2 shows English", () => {
  bases.clear();
  slot = 0;
  const said: { lane: string; text: string }[] = [];
  const mk = (lane: string) => ({
    onSpeech: (b: { tokens: { content: string }[] }) => said.push({ lane, text: b.tokens.map((t) => t.content).join(" ") }),
    onRetract: () => {},
  });
  const segEn = new StubSegmenter();
  const segJa = new StubSegmenter();
  const gEn = new LanguageGate(EN, segEn, () => 0, mk("ja"));
  const gJa = new LanguageGate(JA, segJa, () => 0, mk("en"));
  const router = new LaneRouter([
    { id: "ja", sink: gEn, tick() {} },
    { id: "en", sink: gJa, tick() {} },
  ]);
  router.onResult(part("a", "ja-JP", ["今日", "は", "晴れ", "です"]), 1000);
  router.onResult(part("b", "en-US", ["we", "are", "here", "today"]), 1100);
  assert.deepEqual(said, [
    { lane: "ja", text: "今日 は 晴れ です" },
    { lane: "en", text: "we are here today" },
  ]);
});

test("a lane that throws does not stop the other lane", () => {
  const { segEn, router } = setup();
  const bad: ResultSink = {
    onResult() {
      throw new Error("lane 2 broke");
    },
    endOfStream() {
      throw new Error("lane 2 broke");
    },
  };
  const e = mock.method(console, "error", () => {});
  const l = mock.method(console, "log", () => {});
  try {
    const r2 = new LaneRouter([
      { id: "ja", sink: new LanguageGate(EN, segEn, () => 0), tick() {} },
      { id: "en", sink: bad, tick() { throw new Error("tick"); } },
    ]);
    r2.onResult(part("a", "en-US", ["we", "are", "here", "today"]), 1000);
    r2.tick(1100);
    r2.endOfStream("eof", 1200);
    void router;
  } finally {
    e.mock.restore();
    l.mock.restore();
  }
  assert.equal(kinds(segEn, "result").length, 1);
  assert.equal(kinds(segEn, "eos").length, 1);
});

test("an open Japanese partial at end of stream is committed by lane 2 and dropped by lane 1", () => {
  const { segEn, segJa, router } = setup();
  router.onResult(part("a", "ja-JP", ["今日", "は"], 1), 1000); // unsettled on lane 2
  router.endOfStream("eof", 2000);
  assert.equal(kinds(segJa, "result").length, 1);
  assert.equal(kinds(segEn, "result").length, 0);
  assert.equal(kinds(segEn, "eos").length, 1);
  assert.equal(kinds(segJa, "eos").length, 1);
});

test("lane id appears in the lane's summary and stats counters are per lane", () => {
  const { gEn, gJa, router } = setup();
  router.onResult(fin("a", "ja-JP", ["今日", "は", "晴れ", "です"]), 1000);
  assert.equal(gEn.dropsByReason["non-english"], 1);
  assert.equal(gJa.dropsByReason["non-english"], 0);
  assert.match(gEn.summary(1), /^\[langfilter\] ch=ja stream=1 /);
  assert.match(gJa.summary(1), /^\[langfilter\] ch=en stream=1 .* lateSpoken=0$/);
});

test("a gate without a laneId keeps today's summary line", () => {
  const g = new LanguageGate({ source: "en-US", settleWords: 5, shortWords: 4, shortMinConf: 0.6 }, new StubSegmenter(), () => 0);
  assert.equal(g.summary(2), "[langfilter] stream=2 results=0 kept=0 dropped=0 droppedWords=0 late=0 carried=0 repeats=0");
});
