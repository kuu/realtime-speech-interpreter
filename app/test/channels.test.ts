import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChannelsError, parseChannels, validateChannels, type ChannelsContext } from "../src/channels.js";

interface Case {
  name: string;
  context: ChannelsContext;
  channels: unknown;
  ok?: boolean;
  error?: string;
}
const cases: Case[] = JSON.parse(readFileSync(new URL("./fixtures/channels-cases.json", import.meta.url), "utf8")).cases;

for (const c of cases) {
  test(`channels case: ${c.name}`, () => {
    if (c.ok) {
      const lanes = validateChannels(c.channels, c.context);
      assert.equal(lanes.length, (c.channels as unknown[]).length);
    } else {
      assert.throws(() => validateChannels(c.channels, c.context), (e: unknown) => e instanceof ChannelsError && e.message.includes(c.error as string));
    }
  });
}

test("CHANNELS absent: one lane from the flat variables with today's defaults", () => {
  const lanes = parseChannels({});
  assert.deepEqual(lanes, [
    { source: "en-US", target: "ja", pollyVoice: "Kazuha", transcribeVocabulary: "", translateTerminology: "", translateSource: "en" },
  ]);
  assert.deepEqual(parseChannels({ CHANNELS: "  " }), lanes);
});
test("a ja-JP to en single lane through the flat variables", () => {
  const [l] = parseChannels({ SOURCE_LANGUAGE: "ja-JP", TRANSLATE_SOURCE: "ja", TRANSLATE_TARGET: "en", POLLY_VOICE: "Joanna" });
  assert.equal(l.source, "ja-JP");
  assert.equal(l.target, "en");
  assert.equal(l.translateSource, "ja");
  assert.equal(l.pollyVoice, "Joanna");
});
test("CHANNELS with two lanes parses and uses LANGUAGE_OPTIONS, LANGUAGE_FILTER and TRANSLATE_ENGINE", () => {
  const two = JSON.stringify([
    { source: "en-US", target: "ja", pollyVoice: "Kazuha" },
    { source: "ja-JP", target: "en", pollyVoice: "Joanna" },
  ]);
  assert.equal(parseChannels({ CHANNELS: two }).length, 2);
  assert.throws(() => parseChannels({ CHANNELS: two, LANGUAGE_FILTER: "off" }), /two lanes need languageFilter=langid/);
  assert.throws(() => parseChannels({ CHANNELS: two, LANGUAGE_OPTIONS: "en-US,ko-KR" }), /not in languageOptions/);
  assert.throws(() => parseChannels({ CHANNELS: two, TRANSLATE_ENGINE: "llm" }), /needs translateTerminology/);
  assert.throws(() => parseChannels({ CHANNELS: "{not json" }), /not valid JSON/);
});
