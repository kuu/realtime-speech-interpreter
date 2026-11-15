import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, classifyError, LlmTimeoutError, type BreakerState } from "./llm-breaker.js";

function mk(openMs = 30000) {
  let t = 1000;
  const events: string[] = [];
  const b = new CircuitBreaker({
    openMs,
    now: () => t,
    onTransition: (to: BreakerState, reason: string, forMs: number) => events.push(`${to}|${reason}|${forMs}`),
  });
  return { b, events, advance: (ms: number) => (t += ms) };
}

test("hard failure opens at once and blocks calls", () => {
  const { b, events } = mk();
  assert.equal(b.allow(), true);
  b.onFailure("hard", "throttled");
  assert.equal(b.state, "open");
  assert.equal(b.allow(), false);
  assert.deepEqual(events, ["open|throttled|30000"]);
});

test("3 consecutive soft failures open, 2 do not", () => {
  const a = mk();
  a.b.onFailure("soft", "timeout");
  a.b.onFailure("soft", "timeout");
  assert.equal(a.b.state, "closed");
  a.b.onFailure("soft", "timeout");
  assert.equal(a.b.state, "open");
});

test("success resets soft counters", () => {
  const { b } = mk();
  b.onFailure("soft", "timeout");
  b.onFailure("soft", "timeout");
  b.onSuccess();
  b.onFailure("soft", "timeout");
  b.onFailure("soft", "timeout");
  assert.equal(b.state, "closed");
});

test("5 consecutive content failures open, 4 do not; success resets", () => {
  const { b } = mk();
  for (let i = 0; i < 4; i++) b.onFailure("content", "validation-tag");
  assert.equal(b.state, "closed");
  b.onSuccess();
  for (let i = 0; i < 4; i++) b.onFailure("content", "validation-tag");
  assert.equal(b.state, "closed");
  b.onFailure("content", "validation-tag");
  assert.equal(b.state, "open");
});

test("a different failure kind breaks the consecutive run", () => {
  const { b } = mk();
  b.onFailure("soft", "timeout");
  b.onFailure("soft", "timeout");
  b.onFailure("content", "validation-tag");
  b.onFailure("soft", "timeout");
  assert.equal(b.state, "closed");
});

test("open lasts exactly openMs, then one half-open trial", () => {
  const { b, advance, events } = mk(30000);
  b.onFailure("hard", "throttled");
  advance(29999);
  assert.equal(b.allow(), false);
  advance(1);
  assert.equal(b.allow(), true); // trial
  assert.equal(b.state, "half-open");
  assert.equal(b.allow(), false); // only one trial at a time
  assert.deepEqual(events, ["open|throttled|30000", "half-open|window elapsed|0"]);
});

test("trial success closes", () => {
  const { b, advance, events } = mk();
  b.onFailure("hard", "access");
  advance(30000);
  assert.equal(b.allow(), true);
  b.onSuccess();
  assert.equal(b.state, "closed");
  assert.equal(b.allow(), true);
  assert.equal(events.at(-1), "closed|trial succeeded|0");
});

test("trial failure re-opens for another window", () => {
  const { b, advance } = mk();
  b.onFailure("hard", "throttled");
  advance(30000);
  assert.equal(b.allow(), true);
  b.onFailure("soft", "timeout"); // any kind re-opens from half-open
  assert.equal(b.state, "open");
  advance(29999);
  assert.equal(b.allow(), false);
  advance(1);
  assert.equal(b.allow(), true);
});

test("classifyError: hard names", () => {
  const cases: [string, string][] = [
    ["ThrottlingException", "throttled"],
    ["TooManyRequestsException", "throttled"],
    ["ModelNotReadyException", "model-not-ready"],
    ["AccessDeniedException", "access"],
    ["UnrecognizedClientException", "access"],
    ["ExpiredTokenException", "access"],
    ["ResourceNotFoundException", "bad-request"],
    ["ValidationException", "bad-request"],
  ];
  for (const [name, reason] of cases) {
    const e = Object.assign(new Error("x"), { name });
    assert.deepEqual(classifyError(e), { kind: "hard", reason }, name);
  }
  assert.deepEqual(classifyError({ $metadata: { httpStatusCode: 429 } }), { kind: "hard", reason: "throttled" });
});

test("classifyError: soft names", () => {
  for (const name of ["AbortError", "TimeoutError", "ModelTimeoutException"]) {
    assert.deepEqual(classifyError(Object.assign(new Error("x"), { name })), { kind: "soft", reason: "timeout" }, name);
  }
  assert.deepEqual(classifyError(new LlmTimeoutError(1500)), { kind: "soft", reason: "timeout" });
  for (const name of ["ServiceUnavailableException", "InternalServerException", "ModelErrorException"]) {
    assert.deepEqual(classifyError(Object.assign(new Error("x"), { name })), { kind: "soft", reason: "server-error" }, name);
  }
  for (const code of ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]) {
    assert.deepEqual(classifyError(Object.assign(new Error("x"), { code })), { kind: "soft", reason: "network" }, code);
  }
  assert.deepEqual(classifyError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } })), { kind: "soft", reason: "network" });
  assert.deepEqual(classifyError(Object.assign(new Error("x"), { name: "NetworkingError" })), { kind: "soft", reason: "network" });
  assert.deepEqual(classifyError(new Error("boom")), { kind: "soft", reason: "unknown" });
  assert.deepEqual(classifyError("string"), { kind: "soft", reason: "unknown" });
  assert.deepEqual(classifyError(null), { kind: "soft", reason: "unknown" });
});
