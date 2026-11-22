import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parityView, synthTemplate } from "./helpers";

// `channels` with one default entry must give the default deploy: same container environment, IAM and security groups.
const base = { venueCidr: "203.0.113.10/32,198.51.100.7/32", eventFile: "none" };
const golden = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const oneDefault = JSON.stringify([{ source: "en-US", target: "ja", pollyVoice: "Kazuha" }]);

test("parity: channels with one default entry equals the golden default", () => {
  const view = parityView(synthTemplate({ ...base, channels: oneDefault }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-default.json"));
});
test("parity: channels with one default entry and the user command equals the golden user command", () => {
  const view = parityView(synthTemplate({ ...base, channels: oneDefault, translateEngine: "llm", latencyPreset: "fast" }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-user-command.json"));
});
test("parity: an explicit lane voice is the flat pollyVoice", () => {
  const withVoice = parityView(synthTemplate({ ...base, channels: JSON.stringify([{ source: "en-US", target: "ja", pollyVoice: "Tomoko" }]) }));
  const flat = parityView(synthTemplate({ ...base, pollyVoice: "Tomoko" }));
  assert.deepEqual(JSON.parse(JSON.stringify(withVoice)), JSON.parse(JSON.stringify(flat)));
});
