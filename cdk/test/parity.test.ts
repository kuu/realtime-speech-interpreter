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

test("parity: only venueCidr (the shipped default = LLM engine + talk timing)", () => {
  const view = parityView(synthTemplate({ ...base }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-default.json"));
});
test("parity: -c latencyPreset=careful equals the previous default (Amazon Translate engine, longer chunks)", () => {
  const view = parityView(synthTemplate({ ...base, latencyPreset: "careful" }));
  assert.deepEqual(JSON.parse(JSON.stringify(view)), golden("parity-careful.json"));
});
test("the shipped default equals the user command except the preset label", () => {
  const a = JSON.stringify(parityView(synthTemplate({ ...base })));
  const b = JSON.stringify(parityView(synthTemplate({ ...base, translateEngine: "llm", latencyPreset: "fast" })));
  assert.equal(a.replace('"talk"', '"fast"'), b);
});
test("the talk profile and the preset default equal the shipped default", () => {
  const a = JSON.stringify(parityView(synthTemplate({ ...base })));
  assert.equal(JSON.stringify(parityView(synthTemplate({ ...base, latencyPreset: "talk" }))), a);
  assert.equal(JSON.stringify(parityView(synthTemplate({ ...base, latencyPreset: "default" }))).replace('"default"', '"talk"'), a);
});
test("-c translateEngine=translate under the default equals careful except the label and the timing variables", () => {
  const t = parityView(synthTemplate({ ...base, translateEngine: "translate" })) as Record<string, unknown>;
  const c = parityView(synthTemplate({ ...base, latencyPreset: "careful" })) as Record<string, unknown>;
  const env = (v: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const [id, val] of Object.entries(v)) {
      if (!Array.isArray(val)) continue;
      for (const d of val as Array<{ Environment?: Array<{ Name: string; Value: string }> }>) {
        for (const e of d.Environment ?? []) out[`${id}/${e.Name}`] = e.Value;
      }
    }
    return out;
  };
  const te = env(t);
  const ce = env(c);
  const differing = Object.keys(te).filter((k) => te[k] !== ce[k]).map((k) => k.split("/").pop());
  assert.ok(differing.includes("LATENCY_PRESET"));
  assert.ok(!differing.includes("TRANSLATE_ENGINE"), "same engine");
  assert.ok(differing.includes("CHUNK_MIN_WORDS"), "timing differs");
  // IAM, security groups, instances are identical (Translate only: no Bedrock statement in either).
  const noEnv = (v: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, x]) => !Array.isArray(x))));
  assert.equal(noEnv(t), noEnv(c));
});
