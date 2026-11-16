// Tests for the publisher page's pure logic (app/publisher/publisher-core.js), node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
const m: any = await import(new URL("../publisher/publisher-core.js", import.meta.url).href);
const { mapTokenStatus, audioConstraints, retryDelayMs, formatCode, sha256Hex, createSession, RECONNECT_BOUND_MS } = m;

test("token status mapping: 401 wrong, 403 closed, 429 and 5xx retry", () => {
  assert.equal(mapTokenStatus(200), "ok");
  assert.equal(mapTokenStatus(401), "wrong");
  assert.equal(mapTokenStatus(403), "closed");
  assert.equal(mapTokenStatus(429), "retry");
  assert.equal(mapTokenStatus(500), "retry");
  assert.equal(mapTokenStatus(503), "retry");
  assert.equal(mapTokenStatus(404), "error");
});

test("audio constraints follow browserAudioProcessing", () => {
  assert.deepEqual(audioConstraints("all"), { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(audioConstraints("echo"), { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(audioConstraints("none"), { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(audioConstraints("all", "dev1").deviceId, { exact: "dev1" });
});

test("retry delay doubles to 30 s and adds up to 50% jitter", () => {
  assert.equal(retryDelayMs(0, () => 0), 1000);
  assert.equal(retryDelayMs(3, () => 0), 8000);
  assert.equal(retryDelayMs(10, () => 0), 30000);
  assert.equal(retryDelayMs(10, () => 1), 45000);
});

test("formatCode groups by four and ignores case, spaces, hyphens", () => {
  assert.equal(formatCode("abcd efgh-jkmn"), "ABCD-EFGH-JKMN");
});

test("sha256Hex matches a known digest", async () => {
  assert.equal(await sha256Hex(webcrypto.subtle, "abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("reconnect is allowed only within the bound after the last publish, and never after a takeover", () => {
  let t = 1000;
  const s = createSession(() => t);
  assert.equal(s.canReconnect(), false);
  s.setCode("X");
  assert.equal(s.canReconnect(), false); // never published
  s.published();
  t += RECONNECT_BOUND_MS;
  assert.equal(s.canReconnect(), true);
  t += 1;
  assert.equal(s.canReconnect(), false);
  assert.equal(s.getCode(), "X"); // still held until cleared by the caller
  s.published();
  assert.equal(s.canReconnect(), true);
  s.duplicate();
  assert.equal(s.canReconnect(), false);
  assert.equal(s.hasCode(), false);
});

test("tick moves the bound while the page is connected; clear drops the code", () => {
  let t = 0;
  const s = createSession(() => t);
  s.setCode("X");
  s.published();
  t = 50000; s.tick();
  t = 100000;
  assert.equal(s.canReconnect(), true);
  s.clear();
  assert.equal(s.canReconnect(), false);
  assert.equal(s.getCode(), null);
});
