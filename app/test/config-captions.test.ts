// CAPTIONS env parsing (node:test).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { captions } from "../src/config.js";

test("captions defaults to on, accepts on/off in any case, junk falls back to on", () => {
  const e = mock.method(console, "error", () => {});
  const l = mock.method(console, "log", () => {});
  try {
    assert.equal(captions({}), "on");
    assert.equal(captions({ CAPTIONS: "off" }), "off");
    assert.equal(captions({ CAPTIONS: "OFF" }), "off");
    assert.equal(captions({ CAPTIONS: "on" }), "on");
    assert.equal(captions({ CAPTIONS: "maybe" }), "on");
  } finally {
    e.mock.restore();
    l.mock.restore();
  }
});
