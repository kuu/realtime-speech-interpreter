import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ENGLISH_VOICE, NEURAL_EN_US_VOICES, englishVoiceCheck, isKnownNeuralEnUs } from "../src/polly-voices.js";

test("Joanna is the default English voice and is a known neural en-US voice (describe-voices, ap-northeast-1)", () => {
  assert.equal(DEFAULT_ENGLISH_VOICE, "Joanna");
  assert.equal(isKnownNeuralEnUs("Joanna"), true);
  assert.equal(NEURAL_EN_US_VOICES.length, 13);
});
test("voice and engine regression: a neural lane with a listed voice is known; an unlisted voice is passed to doctor, not rejected", () => {
  assert.deepEqual(englishVoiceCheck("Joanna", "neural"), { ok: true, known: true, note: "known neural en-US voice" });
  const u = englishVoiceCheck("Brian", "neural");
  assert.equal(u.ok, true);
  assert.equal(u.known, false);
  assert.match(u.note, /doctor/);
  assert.equal(englishVoiceCheck("Joanna", "standard").known, false);
});
test("the Japanese voice is not in the English list", () => {
  assert.equal(isKnownNeuralEnUs("Kazuha"), false);
});
