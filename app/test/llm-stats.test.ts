import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmStats, estimateUsd, percentile } from "../src/llm-stats.js";

const U = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheWriteInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheWriteInputTokens,
});

test("percentile: nearest rank", () => {
  assert.equal(percentile([], 90), 0);
  assert.equal(percentile([5], 90), 5);
  const xs = Array.from({ length: 10 }, (_, i) => (i + 1) * 100); // 100..1000
  assert.equal(percentile(xs, 50), 500);
  assert.equal(percentile(xs, 90), 900);
  assert.equal(percentile(xs, 100), 1000);
  assert.equal(percentile([300, 100, 200], 90), 300);
});

test("estUsd arithmetic: 148 in, 24 out, 5143 read", () => {
  // (148*1.00 + 24*5.00 + 5143*0.10) / 1e6 = 782.3 / 1e6
  assert.ok(Math.abs(estimateUsd(U(148, 24, 5143)) - 0.0007823) < 1e-12);
  // cache write: 5190 tokens at 1.25 = 6487.5 / 1e6
  assert.ok(Math.abs(estimateUsd(U(0, 0, 0, 5190)) - 0.0064875) < 1e-12);
});

test("counts, byReason ordering, hit rate, tokens and summary line", () => {
  const s = new LlmStats(true);
  s.recordCall({ ms: 600, usage: U(100, 20, 5000) });
  s.recordUsed();
  s.recordCall({ ms: 700, usage: U(100, 20, 5000) });
  s.recordUsed();
  s.recordCall({ ms: 1500 }); // timeout, no usage
  s.recordFallback("timeout");
  s.recordTranslateCall();
  s.recordFallback("validation-tag");
  s.recordFallback("validation-tag");
  s.recordFallback("skip-backlog");
  s.recordBreakerOpened();
  s.recordCall({ ms: 100, usage: U(10, 1, 0, 5200), warm: true }); // warm-up: tokens only
  assert.equal(s.used, 2);
  assert.equal(s.fallback, 3);
  assert.equal(s.skipBacklog, 1);
  assert.equal(s.cacheHitRate(), 1);
  assert.deepEqual(s.tokens, U(210, 41, 10000, 5200));
  const line = s.summaryLine("session=1");
  assert.equal(
    line,
    "[llm-summary] session=1 engine=llm used=2 fallback=3 byReason=validation-tag:2,timeout:1 skipBacklog=1 breakerOpened=1 " +
      "meanLlmMs=933 p90LlmMs=1500 maxLlmMs=1500 cacheHitRate=1.00 inTok=210 outTok=41 cacheRead=10000 cacheWrite=5200 " +
      "translateCalls=1 estUsd=" +
      s.estUsd().toFixed(4),
  );
});

test("empty stats print zeros and byReason -", () => {
  const line = new LlmStats(true).summaryLine("exit");
  assert.match(line, /^\[llm-summary\] exit engine=llm used=0 fallback=0 byReason=- skipBacklog=0 breakerOpened=0 meanLlmMs=0 p90LlmMs=0 maxLlmMs=0 cacheHitRate=0\.00/);
});

test("rolling cache warning: fires below 0.8, at most once per 60 s, not before 10 samples", () => {
  const s = new LlmStats(true);
  for (let i = 0; i < 9; i++) s.recordCall({ ms: 1, usage: U(1, 1, 0) });
  assert.equal(s.cacheWarning(0), null); // only 9 samples
  s.recordCall({ ms: 1, usage: U(1, 1, 0) });
  const w = s.cacheWarning(1000);
  assert.ok(w && w.startsWith("[llm] cache hit rate low rate=0.00 window=10 inTok=10 cacheRead=0"), String(w));
  assert.equal(s.cacheWarning(1000 + 59999), null);
  assert.ok(s.cacheWarning(1000 + 60000));
});

test("no warning at a good rate, over the last 20 only, or when no cache is expected", () => {
  const s = new LlmStats(true);
  for (let i = 0; i < 20; i++) s.recordCall({ ms: 1, usage: U(1, 1, 0) }); // 20 misses
  for (let i = 0; i < 20; i++) s.recordCall({ ms: 1, usage: U(1, 1, 5000) }); // window now all hits
  assert.equal(s.cacheWarning(0), null);
  const off = new LlmStats(false);
  for (let i = 0; i < 20; i++) off.recordCall({ ms: 1, usage: U(1, 1, 0) });
  assert.equal(off.cacheWarning(0), null);
});
