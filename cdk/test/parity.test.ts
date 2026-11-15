import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parityView, synthTemplate } from "./helpers";

// Goldens were taken from the code before the layered configuration existed (placeholder venue IPs only).
// They pin the ECS container environment, IAM and security groups for the previous deploy commands.
const base = { venueCidr: "203.0.113.10/32,198.51.100.7/32", eventFile: "none" };

function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
}

test("parity: -c translateEngine=llm -c latencyPreset=fast", () => {
  const view = parityView(synthTemplate({ ...base, translateEngine: "llm", latencyPreset: "fast" }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-user-command.json"));
});

test("parity: only venueCidr", () => {
  const view = parityView(synthTemplate({ ...base }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-default.json"));
});

test("the talk profile equals the user command except the preset label", () => {
  const a = JSON.stringify(parityView(synthTemplate({ ...base, latencyPreset: "talk" })));
  const b = JSON.stringify(parityView(synthTemplate({ ...base, translateEngine: "llm", latencyPreset: "fast" })));
  assert.equal(a.replace('"talk"', '"fast"'), b);
});
