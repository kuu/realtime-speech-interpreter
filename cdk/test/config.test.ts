import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { loadConfig, resolveRegion } from "../lib/config";
import { parseJsonc, LISTENER_TIERS } from "../lib/event-config";
import { makeContext } from "./helpers";

const CIDR = "203.0.113.10/32";

function withEvent(event: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "simul-event-"));
  try {
    const path = join(dir, "event.json");
    writeFileSync(path, event);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cfgFor(overrides: Record<string, unknown>) {
  const app = new cdk.App({ context: makeContext({ venueCidr: CIDR, eventFile: "none", ...overrides }) });
  return loadConfig(app);
}

test("no event file, no profile: cdk.json defaults", () => {
  const c = cfgFor({});
  assert.equal(c.latencyPreset, "default");
  assert.equal(c.chunkMinWords, 8);
  assert.equal(c.translateEngine, "translate");
});

test("legacy preset fast: timing bundle, engine untouched", () => {
  const c = cfgFor({ latencyPreset: "fast" });
  assert.equal(c.latencyPreset, "fast");
  assert.equal(c.chunkMinWords, 5);
  assert.equal(c.chunkMaxMs, 2500);
  assert.equal(c.llmTimeoutMs, 1200);
  assert.equal(c.langidSettleMode, "dynamic");
  assert.equal(c.translateEngine, "translate");
});

test("profile talk = fast bundle + LLM engine; careful and default = cdk.json; qa = careful", () => {
  const talk = cfgFor({ latencyPreset: "talk" });
  assert.equal(talk.chunkMinWords, 5);
  assert.equal(talk.translateEngine, "llm");
  for (const name of ["careful", "default", "qa"]) {
    const c = cfgFor({ latencyPreset: name });
    assert.equal(c.chunkMinWords, 8, name);
    assert.equal(c.translateEngine, "translate", name);
  }
});

test("unknown profile fails with the list of names", () => {
  assert.throws(() => cfgFor({ latencyPreset: "bogus" }), /must be one of: .*talk/);
});

test("precedence: -c > event.json > profile > cdk.json", () => {
  // cdk.json chunkMinWords=8; profile talk=5; event=6; -c=7
  withEvent(JSON.stringify({ profile: "talk", advanced: { chunkMinWords: 6, chunkMaxWords: 20 } }), (path) => {
    const base = { eventFile: path };
    assert.equal(cfgFor({ ...base }).chunkMinWords, 6, "event beats profile");
    assert.equal(cfgFor({ ...base }).chunkMaxMs, 2500, "profile beats cdk.json where the event is silent");
    assert.equal(cfgFor({ ...base }).chunkPauseMs, 600, "profile applies via event.profile");
    assert.equal(cfgFor({ ...base }).chunkMaxWords, 20, "event beats cdk.json");
    assert.equal(cfgFor({ ...base, chunkMinWords: 7 }).chunkMinWords, 7, "-c beats event");
    assert.equal(cfgFor({ ...base, latencyPreset: "careful" }).chunkPauseMs, 900, "-c latencyPreset beats event.profile");
    assert.equal(cfgFor({ ...base, latencyPreset: "careful" }).chunkMinWords, 6, "event still beats the -c profile");
  });
});

test("event.json friendly keys map onto context keys", () => {
  withEvent(
    `{
      // comments are allowed
      "venueCidr": ["198.51.100.7/32", "203.0.113.10/32"],
      "region": "us-east-1",
      "sourceLanguage": "en-US", /* block */
      "targetLanguage": "ja",
      "pollyVoice": "Tomoko",
      "pollyReadings": false,
      "translateEngine": "llm",
      "llmModelId": "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
      "dictionaries": { "transcribeVocabulary": "my-vocab", "translateTerminology": "my-terms" },
      "expectedListeners": 800
    }`,
    (path) => {
      const app = new cdk.App({ context: makeContext({ eventFile: path }) });
      const c = loadConfig(app);
      assert.deepEqual(c.venueCidrs, ["198.51.100.7/32", "203.0.113.10/32"]);
      assert.equal(resolveRegion(app), "us-east-1");
      assert.equal(c.pollyVoice, "Tomoko");
      assert.equal(c.pollyReadings, "off");
      assert.equal(c.translateEngine, "llm");
      assert.equal(c.transcribeVocabularyName, "my-vocab");
      assert.equal(c.translateTerminologyName, "my-terms");
      assert.equal(c.translateSource, "en");
      assert.equal(c.livekitInstanceType, "c6i.xlarge");
    },
  );
});

test("expectedListeners tiers", () => {
  assert.equal(LISTENER_TIERS[0].instanceType, "c6i.large");
  withEvent(JSON.stringify({ expectedListeners: 5000, venueCidr: CIDR }), (path) => {
    assert.throws(() => cfgFor({ eventFile: path }), /not supported by one LiveKit node/);
  });
});

test("event.json validation: unknown keys and types are rejected", () => {
  const bad: Array<[string, RegExp]> = [
    [JSON.stringify({ venueCidrs: ["203.0.113.10/32"] }), /unknown key "venueCidrs"/],
    [JSON.stringify({ advanced: { nope: 1 } }), /unknown key "advanced.nope"/],
    [JSON.stringify({ pollyReadings: "on" }), /true or false/],
    [JSON.stringify({ dictionaries: { vocab: "x" } }), /unknown key "dictionaries.vocab"/],
    ["{ not json", /invalid JSON/],
  ];
  for (const [text, re] of bad) withEvent(text, (path) => assert.throws(() => cfgFor({ eventFile: path }), re));
});

test("venue CIDR still required and 0.0.0.0/0 rejected", () => {
  const app = new cdk.App({ context: makeContext({ eventFile: "none" }) });
  assert.throws(() => loadConfig(app), /venueCidr/);
  assert.throws(() => cfgFor({ venueCidr: "0.0.0.0/0" }), /not allowed/);
});

test("parseJsonc keeps // inside strings", () => {
  assert.deepEqual(parseJsonc('{"a": "http://x" // c\n}', "t"), { a: "http://x" });
});

test("a missing eventFile that was asked for is an error", () => {
  assert.throws(() => cfgFor({ eventFile: "/nonexistent/event.json" }), /does not exist/);
});

test("captionsJapaneseSpeech: default on, -c captionsJapaneseSpeech=off, junk is rejected", () => {
  assert.equal(cfgFor({}).captionsJapaneseSpeech, "on");
  assert.equal(cfgFor({ captionsJapaneseSpeech: "off" }).captionsJapaneseSpeech, "off");
  assert.equal(cfgFor({ captionsJapaneseSpeech: "OFF" }).captionsJapaneseSpeech, "off");
  assert.throws(() => cfgFor({ captionsJapaneseSpeech: "maybe" }), /captionsJapaneseSpeech must be "on" or "off"/);
});
test("captions: default on, -c captions=off, junk is rejected", () => {
  assert.equal(cfgFor({}).captions, "on");
  assert.equal(cfgFor({ captions: "off" }).captions, "off");
  assert.equal(cfgFor({ captions: "OFF" }).captions, "off");
  assert.throws(() => cfgFor({ captions: "maybe" }), /captions must be "on" or "off"/);
});
