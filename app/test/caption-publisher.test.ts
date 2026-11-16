// Unit tests for CaptionPublisher (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptionPublisher } from "../src/caption-publisher.js";

interface Sent { topic: string; ev: any }
function fake(opts: { reject?: boolean; noData?: boolean } = {}) {
  const sent: Sent[] = [];
  const transport = opts.noData
    ? {}
    : {
        async publishData(payload: Uint8Array, topic: string) {
          if (opts.reject) throw new Error("boom");
          sent.push({ topic, ev: JSON.parse(new TextDecoder().decode(payload)) });
        },
      };
  return { sent, transport };
}
const tok = (content: string, punct = false, filler = false) => ({ content, punct, filler });
const batch = (resultId: string, tokens: ReturnType<typeof tok>[], audioEnd = 1) => ({ resultId, tokens, audioStart: 0, audioEnd, now: 0 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("coalesces batches of one result within the flush window into one packet", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, true, 40);
  const tap = p.tapFor(1, () => Date.now())!;
  tap.onWords(batch("r1abcdefgh", [tok("so"), tok("today")]));
  tap.onWords(batch("r1abcdefgh", [tok("we"), tok("are"), tok(",", true)]));
  assert.equal(f.sent.length, 0);
  await wait(90);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].topic, "captions");
  assert.equal(f.sent[0].ev.text, "so today we are,");
  assert.equal(f.sent[0].ev.resultId, "r1abcdef");
  assert.equal(f.sent[0].ev.boundary, false);
});

test("boundary and retract flush immediately and keep order; seq strictly increases", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, true, 10_000);
  const tap = p.tapFor(1, () => Date.now())!;
  tap.onWords(batch("r1", [tok("hello"), tok("there"), tok(".", true)]));
  tap.onWords(batch("r2", [tok("gibberish")]));
  tap.onRetract("r2");
  p.sendCaption({ session: 1, chunkSeq: 1, text: "こんにちは", sourceText: "Hello there.", startAt: 1, durationMs: 1 });
  await wait(20);
  assert.deepEqual(f.sent.map((s) => s.ev.op ?? s.ev.type), ["append", "append", "retract", "caption"]);
  assert.equal(f.sent[0].ev.boundary, true);
  assert.equal(f.sent[0].ev.text, "hello there.");
  const seqs = f.sent.map((s) => s.ev.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(p.stats.retracted, 1);
  p.close();
});

test("disabled: no publishData calls, no tap, no timers, no summary", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, false);
  assert.equal(p.tapFor(1, () => 0), undefined);
  p.sendCaption({ session: 1, chunkSeq: 1, text: "x", sourceText: "y", startAt: 1, durationMs: 1 });
  p.flush();
  await wait(10);
  assert.equal(f.sent.length, 0);
  assert.equal(p.summaryLine("x"), null);
});

test("sink without data channel is accepted and sends nothing", () => {
  const f = fake({ noData: true });
  const p = new CaptionPublisher(f.transport, true);
  assert.equal(p.active, false);
  assert.equal(p.tapFor(1, () => 0), undefined);
  p.sendCaption({ session: 1, chunkSeq: 1, text: "x", sourceText: "y", startAt: 1, durationMs: 1 });
});

test("a rejecting publishData is counted and never thrown", async () => {
  const f = fake({ reject: true });
  const p = new CaptionPublisher(f.transport, true);
  p.sendCaption({ session: 1, chunkSeq: 1, text: "x", sourceText: "y", startAt: 1, durationMs: 1 });
  await wait(10);
  assert.equal(p.stats.failed, 1);
  assert.equal(p.stats.caption, 0);
  assert.match(p.summaryLine("exit")!, /^\[captions\] exit caption=0 source=0 retracted=0 failed=1 /);
});

test("fillers are hidden from the English line", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, true, 10);
  const tap = p.tapFor(1, () => 0, (w) => w.toLowerCase() === "like")!;
  tap.onWords(batch("r1", [tok("so"), tok("um", false, true), tok(",", true), tok("like"), tok("this"), tok(".", true)]));
  await wait(20);
  assert.equal(f.sent[0].ev.text, "so this.");
});

test("plain-text safety: words with markup pass through byte-identical", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, true, 10);
  const tap = p.tapFor(1, () => 0)!;
  tap.onWords(batch("r1", [tok("<script>alert(1)</script>"), tok("&"), tok('"q"')]));
  await wait(30);
  assert.equal(f.sent[0].ev.text, '<script>alert(1)</script> & "q"');
});

test("summary line fields", async () => {
  const f = fake();
  const p = new CaptionPublisher(f.transport, true, 5);
  p.tapFor(1, () => Date.now() - 500)!.onWords(batch("r1", [tok("a")], 0));
  await wait(30);
  const line = p.summaryLine("session=1")!;
  assert.match(line, /^\[captions\] session=1 caption=0 source=1 retracted=0 failed=0 sourceLagMs\(avg\/max\)=\d+\/\d+ speech=0 speechRetracted=0 speechLagMs\(avg\/max\)=0\/0$/);
  // CAPTIONS_JA_SPEECH=off: the line is exactly what it was before as-said Japanese existed.
  const off = new CaptionPublisher(f.transport, true, 5, false);
  assert.match(off.summaryLine("session=1")!, /^\[captions\] session=1 caption=0 source=0 retracted=0 failed=0 sourceLagMs\(avg\/max\)=0\/0$/);
});
