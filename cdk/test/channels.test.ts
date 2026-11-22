import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { ChannelsError, channelsEnv, listenerChannels, listenerConfigFields, resolveChannels, type ChannelsContext } from "../lib/channels";
import { makeContext } from "./helpers";

// The same cases the app tests run (app/test/fixtures/channels-cases.json), through the CDK validator.
interface Case { name: string; context: ChannelsContext; channels: unknown; ok?: boolean; error?: string }
const cases: Case[] = JSON.parse(readFileSync(join(__dirname, "..", "..", "app", "test", "fixtures", "channels-cases.json"), "utf8")).cases;
for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    if (c.ok) assert.equal(resolveChannels(c.channels, c.context).length, (c.channels as unknown[]).length);
    else assert.throws(() => resolveChannels(c.channels, c.context), (e: unknown) => e instanceof ChannelsError && e.message.includes(c.error as string));
  });
}

const CIDR = "203.0.113.10/32";
const DEFAULT_LANE = { source: "en-US", target: "ja", pollyVoice: "Kazuha" };
const EN_LANE = { source: "ja-JP", target: "en", pollyVoice: "Joanna" };
const ctxBase: ChannelsContext = { languageOptions: ["en-US", "ja-JP"], languageFilter: "langid", translateEngine: "translate", dictVocabulary: "dv", dictTerminology: "dt" };

function cfgFor(overrides: Record<string, unknown>) {
  const app = new cdk.App({ context: makeContext({ venueCidr: CIDR, eventFile: "none", ...overrides }) });
  return loadConfig(app);
}
function withEvent(event: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "simul-channels-"));
  try {
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify(event));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- dictionary defaults follow the direction (gap 2) ----
test("only an en-US to ja lane takes dictionaries.* as defaults; every other lane gets \"\"", () => {
  const [a, b] = resolveChannels([DEFAULT_LANE, EN_LANE], ctxBase);
  assert.deepEqual([a.transcribeVocabulary, a.translateTerminology], ["dv", "dt"]);
  assert.deepEqual([b.transcribeVocabulary, b.translateTerminology], ["", ""]);
});
test("the en lane listed first still gets \"\" and the ja lane second gets the names", () => {
  const [a, b] = resolveChannels([EN_LANE, DEFAULT_LANE], ctxBase);
  assert.deepEqual([a.transcribeVocabulary, a.translateTerminology], ["", ""]);
  assert.deepEqual([b.transcribeVocabulary, b.translateTerminology], ["dv", "dt"]);
});
test("ja-JP to en as the only channel: names are \"\" and the llm engine is rejected naming the lane", () => {
  const [a] = resolveChannels([EN_LANE], ctxBase);
  assert.deepEqual([a.transcribeVocabulary, a.translateTerminology], ["", ""]);
  assert.throws(() => resolveChannels([EN_LANE], { ...ctxBase, translateEngine: "llm" }), /lane 1 \(ja-JP to en\) uses the llm engine and needs translateTerminology/);
});
test("explicit lane names win; a lane with an explicit name keeps it", () => {
  const [, b] = resolveChannels([DEFAULT_LANE, { ...EN_LANE, transcribeVocabulary: "v-ja", translateTerminology: "t-ja-en" }], ctxBase);
  assert.deepEqual([b.transcribeVocabulary, b.translateTerminology], ["v-ja", "t-ja-en"]);
});
test("the CHANNELS value has stable keys and the resolved names, so the app applies no default", () => {
  const lanes = resolveChannels([DEFAULT_LANE, { ...EN_LANE, translateEngine: "llm", translateTerminology: "t-ja-en" }], ctxBase);
  assert.equal(
    channelsEnv(lanes),
    '[{"source":"en-US","target":"ja","pollyVoice":"Kazuha","transcribeVocabulary":"dv","translateTerminology":"dt"},' +
      '{"source":"ja-JP","target":"en","pollyVoice":"Joanna","transcribeVocabulary":"","translateTerminology":"t-ja-en","translateEngine":"llm"}]',
  );
});

// ---- loadConfig ----
test("no channels = one lane from the flat keys; channels with one default entry gives the same flat values", () => {
  const flat = cfgFor({});
  assert.equal(flat.lanes.length, 1);
  assert.equal(flat.twoLanes, false);
  assert.equal(flat.channelsUsed, false);
  const one = cfgFor({ channels: JSON.stringify([DEFAULT_LANE]) });
  assert.equal(one.twoLanes, false);
  for (const k of ["sourceLanguage", "translateSource", "translateTarget", "pollyVoice", "transcribeVocabularyName", "translateTerminologyName", "translateEngine"] as const) {
    assert.equal(one[k], flat[k], k);
  }
});
test("a single non-default entry runs through the flat keys (ja-JP to en, empty names)", () => {
  const c = cfgFor({ channels: JSON.stringify([EN_LANE]) });
  assert.equal(c.twoLanes, false);
  assert.equal(c.sourceLanguage, "ja-JP");
  assert.equal(c.translateSource, "ja");
  assert.equal(c.translateTarget, "en");
  assert.equal(c.pollyVoice, "Joanna");
  assert.equal(c.transcribeVocabularyName, "");
  assert.equal(c.translateTerminologyName, "");
});
test("a single non-default entry with the llm engine needs a terminology", () => {
  assert.throws(() => cfgFor({ channels: JSON.stringify([EN_LANE]), translateEngine: "llm", llmModelId: "jp.anthropic.claude-haiku-4-5-20251001-v1:0" }), /lane 1 \(ja-JP to en\)/);
  const ok = cfgFor({ channels: JSON.stringify([{ ...EN_LANE, translateTerminology: "t-ja-en" }]), translateEngine: "llm" });
  assert.equal(ok.translateTerminologyName, "t-ja-en");
});
test("two lanes: lane 1 becomes the flat values and CHANNELS is set; the names are resolved by direction", () => {
  const c = cfgFor({ channels: JSON.stringify([EN_LANE, DEFAULT_LANE]) });
  assert.equal(c.twoLanes, true);
  assert.equal(c.sourceLanguage, "ja-JP");
  assert.equal(c.transcribeVocabularyName, "");
  assert.deepEqual(c.lanes.map((l) => l.target), ["en", "ja"]);
  assert.equal(c.lanes[1].transcribeVocabulary, "simul-translation");
});
test("channels with flat language or voice keys is rejected naming both (-c and event.json)", () => {
  assert.throws(() => cfgFor({ channels: JSON.stringify([DEFAULT_LANE, EN_LANE]), pollyVoice: "Tomoko" }), /channels cannot be combined with "pollyVoice" \(set by -c\)/);
  assert.throws(() => cfgFor({ channels: JSON.stringify([DEFAULT_LANE, EN_LANE]), sourceLanguage: "ja-JP" }), /channels cannot be combined with "sourceLanguage"/);
  assert.throws(() => cfgFor({ channels: JSON.stringify([DEFAULT_LANE, EN_LANE]), translateTarget: "fr" }), /channels cannot be combined with "translateTarget"/);
  withEvent({ venueCidr: CIDR, channels: [DEFAULT_LANE, EN_LANE], pollyVoice: "Tomoko" }, (path) => {
    assert.throws(() => cfgFor({ eventFile: path }), /"channels" cannot be combined with "pollyVoice"/);
  });
  withEvent({ venueCidr: CIDR, channels: [DEFAULT_LANE, EN_LANE], advanced: { pollyVoice: "Tomoko" } }, (path) => {
    assert.throws(() => cfgFor({ eventFile: path }), /channels cannot be combined with "pollyVoice" \(set by event.json\)/);
  });
});
test("channels from event.json work; other flat keys (translateEngine, dictionaries) stay valid", () => {
  withEvent({ venueCidr: CIDR, channels: [DEFAULT_LANE, EN_LANE], dictionaries: { transcribeVocabulary: "dv2", translateTerminology: "dt2" } }, (path) => {
    const c = cfgFor({ eventFile: path });
    assert.equal(c.twoLanes, true);
    assert.equal(c.lanes[0].transcribeVocabulary, "dv2");
    assert.equal(c.lanes[0].translateTerminology, "dt2");
  });
  withEvent({ venueCidr: CIDR, channels: "nope" }, (path) => {
    assert.throws(() => cfgFor({ eventFile: path }), /"channels" must be a list/);
  });
});
test("validation: three lanes, duplicates, same language, unknown key, languageFilter off with two lanes", () => {
  const bad = (v: unknown, extra: Record<string, unknown> = {}) => () => cfgFor({ channels: JSON.stringify(v), ...extra });
  assert.throws(bad([DEFAULT_LANE, EN_LANE, { source: "ko-KR", target: "ko", pollyVoice: "Seoyeon" }]), /needs 1 to 2 lanes/);
  assert.throws(bad([DEFAULT_LANE, { ...DEFAULT_LANE, target: "de" }]), /lane sources must be distinct/);
  assert.throws(bad([{ source: "en-US", target: "en", pollyVoice: "Joanna" }]), /into the same language/);
  assert.throws(bad([{ ...DEFAULT_LANE, speedMode: "off" }]), /unknown key "speedMode"/);
  assert.throws(bad([DEFAULT_LANE, EN_LANE], { languageFilter: "off" }), /two lanes need languageFilter=langid/);
  assert.throws(bad([DEFAULT_LANE, EN_LANE], { languageOptions: "en-US,ko-KR" }), /not in languageOptions/);
  assert.throws(() => cfgFor({ channels: "{not json" }), /is not valid JSON/);
});
test("a two-lane deploy with the llm engine on lane 2 only needs the jp. model id check", () => {
  const lanes = [DEFAULT_LANE, { ...EN_LANE, translateEngine: "llm", translateTerminology: "t-ja-en" }];
  assert.throws(() => cfgFor({ channels: JSON.stringify(lanes), llmModelId: "anthropic.claude" }), /llmModelId must be a Japan inference profile/);
  assert.equal(cfgFor({ channels: JSON.stringify(lanes) }).twoLanes, true);
});

// ---- ja* keys ----
test("ja keys: defaults, profile talk, and -c precedence", () => {
  const c = cfgFor({});
  assert.deepEqual([c.jaSegmentationMode, c.jaMaxWaitMs, c.jaClauseMinChars, c.jaMaxChars, c.jaPauseMs], ["simple", 4000, 12, 40, 900]);
  assert.deepEqual([c.langidSettleItems, c.langidSettleItemsDefault, c.langidSettleItemsAfterEn], [5, 3, 5]);
  const talk = cfgFor({ latencyPreset: "talk" });
  assert.deepEqual([talk.jaMaxWaitMs, talk.jaClauseMinChars, talk.jaMaxChars, talk.jaPauseMs, talk.jaSegmentationMode], [2500, 8, 30, 600, "simple"]);
  assert.equal(cfgFor({ latencyPreset: "fast" }).jaMaxWaitMs, 2500);
  assert.equal(cfgFor({ latencyPreset: "talk", jaMaxWaitMs: 1000 }).jaMaxWaitMs, 1000);
  assert.equal(cfgFor({ latencyPreset: "careful" }).jaMaxWaitMs, 4000);
});
test("ja keys: invalid values and overlapping lists are rejected", () => {
  assert.throws(() => cfgFor({ jaSegmentationMode: "clause" }), /jaSegmentationMode must be "simple" or "full"/);
  assert.equal(cfgFor({ jaSegmentationMode: "Full" }).jaSegmentationMode, "full");
  assert.throws(() => cfgFor({ jaMaxChars: 2 }), /jaMaxChars must be an integer 4-400/);
  assert.throws(() => cfgFor({ jaShortMinConf: 2 }), /jaShortMinConf/);
  assert.throws(() => cfgFor({ langidSettleItems: 0 }), /langidSettleItems must be an integer 1-50/);
  assert.throws(() => cfgFor({ jaClauseEndings: "ので,が", jaDanglingTokens: "が,を" }), /must not overlap/);
  assert.throws(() => cfgFor({ jaClauseEndings: "ので, けど" }), /without spaces/);
  assert.equal(cfgFor({ jaClauseEndings: "ので,けど", jaDanglingTokens: "が,を" }).jaClauseEndings, "ので,けど");
});

// ---- config.json and URLs ----
test("config.json channel fields: absent by default and for flat keys; present for two lanes and a non-default single lane", () => {
  assert.deepEqual(listenerConfigFields(cfgFor({})), {});
  assert.deepEqual(listenerConfigFields(cfgFor({ channels: JSON.stringify([DEFAULT_LANE]) })), {});
  assert.deepEqual(listenerConfigFields(cfgFor({ sourceLanguage: "ja-JP", translateTarget: "en" })), {});
  const two = listenerConfigFields(cfgFor({ channels: JSON.stringify([DEFAULT_LANE, EN_LANE]) }));
  assert.equal(two.defaultChannel, "ja");
  assert.deepEqual(two.channels, [
    { id: "ja", sourceLang: "en", targetLang: "ja", track: "translation-audio", publisher: "publisher-app", topic: "captions" },
    { id: "en", sourceLang: "ja", targetLang: "en", track: "translation-audio-en", publisher: "publisher-app-en", topic: "captions-en" },
  ]);
  const single = listenerConfigFields(cfgFor({ channels: JSON.stringify([EN_LANE]) }));
  assert.equal(single.defaultChannel, "en");
  assert.equal(single.channels?.length, 1);
  assert.equal(single.channels?.[0].track, "translation-audio", "the first lane keeps the legacy names");
});
test("listener channel names: the first lane keeps the legacy names, whatever its language", () => {
  const lanes = resolveChannels([EN_LANE, DEFAULT_LANE], ctxBase);
  assert.deepEqual(listenerChannels(lanes).map((c) => [c.id, c.track, c.publisher, c.topic]), [
    ["en", "translation-audio", "publisher-app", "captions"],
    ["ja", "translation-audio-ja", "publisher-app-ja", "captions-ja"],
  ]);
});
test("a Japanese vocabulary file in the dictionary folder without a lane vocabulary warns (not an error)", () => {
  const dir = mkdtempSync(join(tmpdir(), "simul-dict-"));
  try {
    writeFileSync(join(dir, "polly-readings.csv"), "term,reading\n");
    writeFileSync(join(dir, "transcribe-vocabulary-ja.txt"), "Phrase\tDisplayAs\n");
    const c = cfgFor({ dictionaryDir: dir, channels: JSON.stringify([DEFAULT_LANE, EN_LANE]) });
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /lane 2 \(ja-JP to en\) has no transcribeVocabulary/);
    assert.match(c.warnings[0], /<transcribeVocabulary>-ja/);
    const set = cfgFor({ dictionaryDir: dir, channels: JSON.stringify([DEFAULT_LANE, { ...EN_LANE, transcribeVocabulary: "simul-translation-ja" }]) });
    assert.deepEqual(set.warnings, []);
    assert.deepEqual(cfgFor({ dictionaryDir: dir }).warnings, [], "the default deploy never warns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
