import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHandler, normalizeCode } from "../lambda/publisher-token/handler.mjs";

const CODE = "ABCD-EFGH-JKMN";
const NOT_AFTER = "2026-11-06T09:00:00Z";
const T0 = Date.parse("2026-11-06T08:00:00Z");

function make(over = {}) {
  const logs = [];
  const state = { code: CODE, notAfter: NOT_AFTER, now: T0, sleeps: [], compares: 0 };
  const h = createHandler({
    readCode: async () => state.code,
    readNotAfter: async () => state.notAfter,
    readLiveKit: async () => ({ apiKey: "k", apiSecret: "s".repeat(32) }),
    room: "translation-ingest",
    ttlSec: 600,
    livekitUrl: "wss://example.invalid",
    now: () => state.now,
    sleep: async (ms) => { state.sleeps.push(ms); },
    compare: (a, b) => { state.compares++; return a.length === b.length && Buffer.compare(a, b) === 0; },
    log: (l) => logs.push(l),
    ...over,
  });
  const call = (body, extra = {}) => h({
    requestContext: { http: { method: "POST" } },
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7, 10.0.0.1", ...(extra.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "headers")),
  });
  return { h, call, state, logs };
}
const decode = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

test("right code: exact grant, identity, room and TTL", async () => {
  const { call } = make();
  const r = await call({ code: "abcd efgh-jkmn" });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  const p = decode(b.token);
  assert.equal(p.sub, "browser-publisher");
  assert.equal(p.exp - p.nbf, 600);
  assert.deepEqual(p.video, {
    room: "translation-ingest", roomJoin: true, canPublish: true, canPublishSources: ["microphone"],
    canPublishData: false, canSubscribe: false, canUpdateOwnMetadata: false,
  });
  assert.equal(b.url, "wss://example.invalid");
  assert.equal(b.expiresAt, new Date(T0 + 600000).toISOString());
});

test("wrong code, wrong type, oversize, bad JSON, missing field: byte-identical 401 and no token", async () => {
  const { call, state } = make();
  const cases = [
    call({ code: "WRONGWRONGWR" }),
    call({ code: "" }),
    call({}),
    call({ code: 5 }),
    call("not json"),
    call({ code: CODE }, { headers: { "content-type": "text/plain" } }),
    call({ code: CODE, pad: "x".repeat(300) }),
  ];
  const rs = await Promise.all(cases);
  for (const r of rs) {
    assert.equal(r.statusCode, 401);
    assert.equal(r.body, '{"error":"invalid"}');
    assert.ok(!r.body.includes("token"));
  }
  assert.deepEqual(state.sleeps.filter((s) => s !== 1000), []);
});

test("wrong code waits once for 1000 ms; right code does not wait", async () => {
  const { call, state } = make();
  await call({ code: "WRONGWRONGWR" });
  assert.deepEqual(state.sleeps, [1000]);
  await call({ code: CODE });
  assert.deepEqual(state.sleeps, [1000]);
});

test("comparison goes through the injected constant-time comparer on equal-length digests", async () => {
  let lens = null;
  const { call } = make({ compare: (a, b) => { lens = [a.length, b.length]; return false; } });
  await call({ code: "X" });
  assert.deepEqual(lens, [32, 32]);
});

test("rotation: the old code is rejected on the next request, the new one accepted", async () => {
  const { call, state } = make();
  assert.equal((await call({ code: CODE })).statusCode, 200);
  state.code = "QRST-UVWX-YZ23";
  assert.equal((await call({ code: CODE })).statusCode, 401);
  assert.equal((await call({ code: "qrstuvwxyz23" })).statusCode, 200);
});

test("event end: 403 after notAfter, even for a wrong code; 200 before", async () => {
  const { call, state } = make();
  assert.equal((await call({ code: CODE })).statusCode, 200);
  state.now = Date.parse(NOT_AFTER);
  const bad = await call({ code: "WRONGWRONGWR" });
  const good = await call({ code: CODE });
  assert.equal(bad.statusCode, 403);
  assert.equal(good.statusCode, 403);
  assert.equal(good.body, '{"error":"not available"}');
});

test("fails closed: short stored code, missing or garbled end time", async () => {
  for (const code of ["ABCDEFGHJ", ""]) {
    const { call, state } = make();
    state.code = code;
    const r = await call({ code });
    assert.equal(r.statusCode, 500);
    assert.ok(!r.body.includes("token"));
  }
  for (const v of [undefined, "", "tomorrow", "2026-11-06T09:00:00+09:00", "2026-11-06T09:00:00.000Z", "2026-02-30T00:00:00Z"]) {
    const { call, state } = make();
    state.notAfter = v;
    const r = await call({ code: CODE });
    assert.equal(r.statusCode, 500, String(v));
    assert.equal(r.body, '{"error":"internal error"}');
  }
});

test("non-POST gets 405; base64 body is decoded", async () => {
  const { h, call } = make();
  assert.equal((await h({ requestContext: { http: { method: "GET" } } })).statusCode, 405);
  const r = await call(Buffer.from(JSON.stringify({ code: CODE })).toString("base64"), { isBase64Encoded: true });
  assert.equal(r.statusCode, 200);
});

test("logs never contain the code or any 4-character piece of it", async () => {
  const known = "QWER-TYUP-ASDF";
  const seen = [];
  const spy = (...a) => seen.push(a.join(" "));
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = spy; console.error = spy; console.warn = spy;
  try {
    const logs = [];
    const { call, state } = make({ log: (l) => { logs.push(l); console.log(l); } });
    state.code = known;
    await call({ code: known });
    await call({ code: "QWERTYUPASDG" });
    await call("garbage");
    const all = [...logs, ...seen].join("\n").toUpperCase();
    const flat = "QWERTYUPASDF";
    for (let i = 0; i + 4 <= flat.length; i++) assert.ok(!all.includes(flat.slice(i, i + 4)), flat.slice(i, i + 4));
    assert.match(logs.join("\n"), /outcome=ok addr=198\.51\.100\.7 /);
    assert.match(logs.join("\n"), /outcome=bad_code/);
    assert.match(logs.join("\n"), /outcome=malformed/);
  } finally {
    console.log = origLog; console.error = origErr; console.warn = origWarn;
  }
});

test("normalizeCode drops case, spaces and hyphens", () => {
  assert.equal(normalizeCode("ab cd-ef"), "ABCDEF");
});
