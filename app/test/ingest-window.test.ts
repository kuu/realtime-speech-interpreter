// Event window of the browser input, with a fake clock (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PublisherWindow, parseNotAfter } from "../src/ingest-window.js";

const quiet = { info() {}, warn() {} };
const T0 = Date.parse("2026-11-06T08:00:00Z");

test("parseNotAfter accepts only the strict UTC form", () => {
  assert.equal(parseNotAfter("2026-11-06T09:00:00Z"), Date.parse("2026-11-06T09:00:00Z"));
  for (const v of [undefined, "", "2026-11-06T09:00:00+09:00", "2026-11-06", "2026-02-30T00:00:00Z", "2026-11-06T09:00:00.000Z"]) assert.equal(parseNotAfter(v as string), null);
});

test("unreadable or missing at start means closed; open before the end time; close fires once at the end time", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
  try {
    let closed = 0;
    const w0 = new PublisherWindow(async () => undefined, () => closed++, quiet, 60000);
    await w0.start();
    assert.equal(w0.isOpen(), false);
    w0.stop();

    let value: string | undefined = "2026-11-06T09:00:00Z";
    const w = new PublisherWindow(async () => value, () => closed++, quiet, 60000);
    await w.start();
    assert.equal(w.isOpen(), true);
    mock.timers.tick(59 * 60 * 1000);
    assert.equal(closed, 0);
    mock.timers.tick(60 * 1000);
    assert.equal(w.isOpen(), false);
    assert.equal(closed, 1);
    w.stop();
  } finally {
    mock.timers.reset();
  }
});

test("rotation: a new end time moves the timer within one poll (60 s)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
  try {
    let closed = 0;
    let value = "2026-11-06T08:30:00Z";
    const w = new PublisherWindow(async () => value, () => closed++, quiet, 60000);
    await w.start();
    value = "2026-11-06T10:00:00Z"; // operator moves the end time later
    mock.timers.tick(60 * 1000);
    await Promise.resolve(); await Promise.resolve();
    mock.timers.tick(40 * 60 * 1000); // past the old end time
    assert.equal(closed, 0);
    assert.equal(w.isOpen(), true);
    w.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a read error after start keeps the last value", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: T0 });
  try {
    let fail = false;
    const w = new PublisherWindow(async () => { if (fail) throw new Error("ssm down"); return "2026-11-06T09:00:00Z"; }, () => {}, quiet, 60000);
    await w.start();
    fail = true;
    mock.timers.tick(60 * 1000);
    await Promise.resolve();
    assert.equal(w.isOpen(), true);
    w.stop();
  } finally {
    mock.timers.reset();
  }
});
