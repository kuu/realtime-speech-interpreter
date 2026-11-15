// Unit tests for the SRT listener's ffmpeg arguments (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { listenerArgs } from "./srt-source.js";

const URL = "srt://127.0.0.1:9000?mode=listener&latency=120000&listen_timeout=3600000000";
// The arguments before SRT_ANALYZE_MS existed (= analyzeMs 0, the revert).
const TODAY = [
  "-hide_banner", "-loglevel", "warning", "-i", URL, "-vn", "-f", "s16le", "-acodec", "pcm_s16le",
  "-ac", "1", "-ar", "16000", "pipe:1",
];

test("analyzeMs 0: exactly the old ffmpeg arguments", () => {
  assert.deepEqual(listenerArgs(URL, 0, 1, 16000), TODAY);
});

test("analyzeMs 500: -analyzeduration 500000 (µs) right before -i, rest unchanged", () => {
  const a = listenerArgs(URL, 500, 1, 16000);
  const i = a.indexOf("-i");
  assert.deepEqual(a.slice(i - 2, i), ["-analyzeduration", "500000"]);
  assert.equal(a[i + 1], URL);
  assert.deepEqual(a.filter((_, k) => k !== i - 2 && k !== i - 1), TODAY);
});
