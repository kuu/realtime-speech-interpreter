import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { parseChannels } from "../src/channels.js";
import { laneSettingsFor } from "../src/lane-settings.js";

test("lane 1 of a default deploy equals today's config values and legacy names", () => {
  const [spec] = parseChannels(process.env);
  const l = laneSettingsFor(spec, 0);
  assert.equal(l.id, "ja");
  assert.equal(l.polly.voiceId, config.polly.voiceId);
  assert.equal(l.polly.engine, config.polly.engine);
  assert.equal(l.polly.sampleRateHertz, config.polly.sampleRateHertz);
  assert.equal(l.speed, config.playback.speed);
  assert.deepEqual(l.translate, { ...config.translate });
  assert.deepEqual(l.livekit, {
    roomName: config.livekit.roomName,
    identity: "publisher-app",
    trackName: "translation-audio",
    captionTopic: "captions",
  });
  assert.equal(l.captionIdPrefix, "");
});
test("lane 2 (English): voice, no formality, speed off, own names", () => {
  const l = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t-ja-en" }, 1);
  assert.equal(l.polly.voiceId, "Joanna");
  assert.equal(l.speed.mode, "off");
  assert.equal(l.translate.formality, "off");
  assert.equal(l.translate.sourceLanguageCode, "ja");
  assert.equal(l.translate.targetLanguageCode, "en");
  assert.equal(l.translate.terminologyName, "t-ja-en");
  assert.deepEqual(
    { i: l.livekit.identity, t: l.livekit.trackName, c: l.livekit.captionTopic, p: l.captionIdPrefix },
    { i: "publisher-app-en", t: "translation-audio-en", c: "captions-en", p: "en:" },
  );
});
test("a lane engine overrides the global one", () => {
  const l = laneSettingsFor({ source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "t", translateEngine: "llm" }, 1);
  assert.equal(l.translate.engine, "llm");
});
