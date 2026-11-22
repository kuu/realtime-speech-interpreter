// scripts/estimate-cost.mjs: the default output is unchanged and channel 2 adds only what is billed per translated speech.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimate, loadSizing } from "../estimate-cost.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "estimate-cost.mjs");
const prices = JSON.parse(readFileSync(join(HERE, "..", "cost-prices.json"), "utf8"));
const sizing = { ctx: { taskCpu: 1024, taskMemoryMiB: 2048, translateEngine: "llm" }, ev: {}, usedEvent: false };
const P = prices.prices;

test("--channels 1 (or no flag) gives exactly today's numbers and no channel 2 line", () => {
  const a = estimate({ engine: "llm" }, sizing, prices);
  const b = estimate({ engine: "llm", channels: "1" }, sizing, prices);
  assert.deepEqual(b.perHour, a.perHour);
  assert.equal(b.sessionHour, a.sessionHour);
  assert.equal(Object.keys(a.perHour).some((k) => k.startsWith("Channel 2")), false);
  assert.equal(a.meta.channels, 1);
});
test("channel 2 with the Translate engine adds Translate and Polly English only", () => {
  const base = estimate({ engine: "translate" }, sizing, prices);
  const two = estimate({ engine: "translate", channels: "2", "ja-share": "0.5", "en-chars-per-chunk": "60" }, sizing, prices);
  const extra = Object.entries(two.perHour).filter(([k]) => k.startsWith("Channel 2"));
  assert.deepEqual(extra.map(([k]) => k).sort(), ["Channel 2 Bedrock Haiku 4.5 (input + cache read + output)", "Channel 2 Polly neural, English voice", "Channel 2 Translate (Japanese to English)"]);
  const chunks2 = 1130 * 0.5;
  assert.ok(Math.abs(two.perHour["Channel 2 Polly neural, English voice"] - chunks2 * 60 * P.pollyNeuralChar.usd) < 1e-12);
  assert.ok(Math.abs(two.perHour["Channel 2 Translate (Japanese to English)"] - chunks2 * 28.3 * P.translateChar.usd) < 1e-12);
  assert.equal(two.perHour["Channel 2 Bedrock Haiku 4.5 (input + cache read + output)"], 0);
  // everything that is not channel 2 is the same: Transcribe, Fargate, LiveKit and transfer do not grow
  for (const [k, v] of Object.entries(base.perHour)) assert.equal(two.perHour[k], v, k);
});
test("channel 2 with the LLM engine adds the model calls, the second cache write and keep-warm", () => {
  const two = estimate({ engine: "llm", channels: "2", "ja-share": "0.25", hours: "4" }, sizing, prices);
  assert.ok(two.perHour["Channel 2 Bedrock Haiku 4.5 (input + cache read + output)"] > 0);
  const write = (5300 * P.bedrockHaikuRegionalCacheWriteMTok.usd) / 1e6 / 4;
  assert.ok(Math.abs(two.perHour["Channel 2 second-glossary cache write (once per start, spread over the session)"] - write) < 1e-12);
  const warm = (15 * 5470 * P.bedrockHaikuRegionalCacheReadMTok.usd) / 1e6;
  assert.ok(Math.abs(two.perHour["Channel 2 second-glossary keep-warm calls"] - warm) < 1e-12, "15 keep-warm calls per hour (every 4 minutes)");
  assert.ok(two.sessionHour > estimate({ engine: "llm" }, sizing, prices).sessionHour);
});
test("ja-share 0 leaves only the second glossary's fixed lines", () => {
  const two = estimate({ engine: "llm", channels: "2", "ja-share": "0" }, sizing, prices);
  assert.equal(two.perHour["Channel 2 Polly neural, English voice"], 0);
  assert.equal(two.perHour["Channel 2 Translate (Japanese to English)"], 0);
  assert.ok(two.perHour["Channel 2 second-glossary keep-warm calls"] > 0);
});
test("the CLI rejects --channels 3 and --ja-share above 1, and --help lists the new options", () => {
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(run("--channels", "3").status, 2);
  assert.match(run("--channels", "3").stderr, /--channels must be 1 or 2/);
  assert.equal(run("--channels", "2", "--ja-share", "1.5").status, 2);
  const help = run("--help").stdout;
  assert.match(help, /--channels 1\|2/);
  assert.match(help, /--ja-share F/);
  const md = run("--channels", "2", "--markdown", "--hours", "1").stdout;
  assert.match(md, /Channel 2 \(Japanese to English\) included: Japanese share of the hour 0\.25 \(assumed\)/);
});
test("with no --engine, no event file and the real cdk.json the engine is llm (the shipped default)", () => {
  const real = loadSizing();
  assert.equal(real.ctx.translateEngine, "llm");
  if (!real.usedEvent) {
    assert.equal(estimate({}, real, prices).meta.engine, "llm");
    assert.equal(estimate({ engine: "translate" }, real, prices).meta.engine, "translate");
  }
  assert.equal(estimate({}, { ctx: { taskCpu: 1024, taskMemoryMiB: 2048 }, ev: {}, usedEvent: false }, prices).meta.engine, "llm", "no engine anywhere: llm");
});
