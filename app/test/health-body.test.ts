import { test } from "node:test";
import assert from "node:assert/strict";
import { healthBody } from "../src/health-body.js";

test("the one-lane body stays exactly ok", () => {
  assert.equal(healthBody(null), "ok");
  assert.equal(healthBody([{ id: "ja", status: "up" }]), "ok");
});
test("a two-lane body lists the lanes; a disabled lane shows", () => {
  assert.equal(healthBody([{ id: "ja", status: "up" }, { id: "en", status: "up" }]), "ok lanes=ja:up,en:up");
  assert.equal(healthBody([{ id: "ja", status: "up" }, { id: "en", status: "disabled" }]), "ok lanes=ja:up,en:disabled");
});
