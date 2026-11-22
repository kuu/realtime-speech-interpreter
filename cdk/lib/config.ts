import { Construct } from "constructs";
import { buildResolver } from "./event-config";
import { resolveDictionary } from "./dictionary-dir";
import { ChannelsError, isDefaultLane, parseChannelsSetting, resolveChannels, type LaneSpec } from "./channels";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Every configurable value comes from cdk.json "context", config/event.json or a profile (override with -c key=value).
// Values passed with -c arrive as strings, so numbers are parsed and validated here.

export interface StackConfig {
  latencyPreset: string;
  venueCidrs: string[];
  appPath: string;
  srtPort: number;
  srtLatencyMs: number;
  srtListenTimeoutSec: number;
  srtAnalyzeMs: number;
  healthPort: number;
  sampleRate: number;
  frameBytes: number;
  sourceLanguage: string;
  partialStability: string;
  languageFilter: string;
  languageOptions: string;
  langidSettleWords: number;
  langidSettleMode: string;
  langidSettleWordsDefault: number;
  langidSettleWordsAfterJa: number;
  langidJaMemoryMs: number;
  langidSettleItems: number;
  langidSettleItemsDefault: number;
  langidSettleItemsAfterEn: number;
  langidShortWords: number;
  langidShortMinConf: number;
  jaSegmentationMode: string;
  jaSentenceMinChars: number;
  jaClauseMinChars: number;
  jaMaxChars: number;
  jaPauseMs: number;
  jaMaxWaitMs: number;
  jaClauseEndings: string;
  jaDanglingTokens: string;
  jaDanglingMaxChars: number;
  jaShortChars: number;
  jaShortMinConf: number;
  segmentationMode: string;
  chunkMinWords: number;
  chunkMaxWords: number;
  chunkMaxMs: number;
  chunkPauseMs: number;
  chunkConjunctions: string;
  mergeShort: string;
  sentenceMinWords: number;
  sentenceCompleteWords: number;
  mergePauseMs: number;
  mergeMaxHoldMs: number;
  danglingGuard: string;
  danglingWords: string;
  danglingMaxWords: number;
  danglingMaxHoldMs: number;
  cutLookaheadMs: number;
  shortSentenceJoin: string;
  shortSentenceWords: number;
  shortJoinPauseMs: number;
  speedupSteps: string;
  maxBacklogMs: number;
  speedMode: string;
  speedLevels: string;
  speedThresholdsMs: string;
  speedHysteresisMs: number;
  speedHoldMs: number;
  speedUrgentMs: number;
  speedLookahead: number;
  speedMsPerChar: number;
  speedResetGapMs: number;
  fillerFilter: string;
  fillerWords: string;
  fillerPhrases: string;
  jaFillerPatterns: string;
  enableCorrection: string;
  translateSource: string;
  translateTarget: string;
  translateFormality: string;
  translateEngine: string;
  llmModelId: string;
  llmTimeoutMs: number;
  llmContextChunks: number;
  llmContextResetMs: number;
  llmGlossary: string;
  llmMaxTokens: number;
  llmBreakerMs: number;
  llmSkipBacklogMs: number;
  llmParallelFallback: string;
  llmMaxCharsPerWord: number;
  llmKeepWarmMs: number;
  llmPromptVersion: number;
  transcribeVocabularyName: string;
  translateTerminologyName: string;
  pollyVoice: string;
  pollyEngine: string;
  pollySampleRate: number;
  pollyReadings: string;
  /** Output lanes of this deploy: one (the flat keys, or a one-entry `channels`) or two (`channels`). */
  lanes: LaneSpec[];
  /** True when `channels` has two lanes: the container gets CHANNELS. */
  twoLanes: boolean;
  /** True when the `channels` setting was used (config.json lists the channels for two lanes or one non-default lane). */
  channelsUsed: boolean;
  /** Printed at synth (not errors). */
  warnings: string[];
  /** Resolved dictionary folder (absolute). Its polly-readings.csv is copied into the app image. */
  dictionaryDir: string;
  dictionaryDirSource: string;
  captions: string;
  captionsJapaneseSpeech: string;
  roomName: string;
  publisherTokenTtl: string;
  listenerTokenTtlSec: number;
  livekitApiKey: string;
  livekitHostname: string;
  livekitInstanceType: string;
  livekitImage: string;
  caddyImage: string;
  livekitUdpPortStart: number;
  livekitUdpPortEnd: number;
  livekitTcpPort: number;
  inputSource: string;
  rtmpPort: number;
  browserInputConcurrency: number;
  browserInputTokenTtlSec: number;
  browserSessionGraceSec: number;
  browserAudioProcessing: string;
  browserSilenceDb: number;
  browserSilenceSec: number;
  taskCpu: number;
  taskMemoryMiB: number;
  desiredCount: number;
  logLevel: string;
  logRetentionDays: number;
}

const VENUE_CIDR_ERROR =
  'Missing/invalid required context "venueCidr". Pass -c venueCidr=<venue egress IP>/32 ' +
  "(comma-separated for several). 0.0.0.0/0 is not allowed.";

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;

// ---- layers and profiles -------------------------------------------------------------------------
// Precedence (see lib/event-config.ts and docs/configuration.md):
//   explicit -c key=value  >  config/event.json  >  profile (-c latencyPreset=<name>)  >  cdk.json.
// "Explicit" = a -c value that differs from the one in cdk.json. Profiles live in config/profiles/*.json
// (talk, careful, qa; the old names fast and default still work). Every profile key must be a cdk.json key.
// "fast" (= talk without the engine switch) is tuned for translateEngine=llm (configuration P3d, measured on
// recorded talks): the first chunk of a sentence is cut after 5 words or 2.5 s, short sentences are no longer
// held or joined, pause/dangling holds are shorter, the language-ID settle is dynamic, and the LLM call gets
// a 1.2 s budget. Speed levels and llmSkipBacklogMs stay at the cdk.json values.

function parseVenueCidrs(raw: unknown): string[] {
  if (raw === undefined || raw === null) throw new Error(VENUE_CIDR_ERROR);
  const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) throw new Error(VENUE_CIDR_ERROR);
  for (const cidr of list) {
    if (!CIDR_RE.test(cidr)) throw new Error(`${VENUE_CIDR_ERROR} Got: "${cidr}"`);
    const [ip, prefix] = cidr.split("/");
    if (ip.split(".").some((o) => Number(o) > 255)) throw new Error(`${VENUE_CIDR_ERROR} Got: "${cidr}"`);
    if (Number(prefix) === 0) throw new Error(`${VENUE_CIDR_ERROR} Got: "${cidr}"`);
  }
  return list;
}

function intRangeEarly(cfg: StackConfig, key: keyof StackConfig, min: number, max: number, note = ""): void {
  const v = cfg[key] as number;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} must be an integer ${min}-${max}${note}`);
}

/** Region for the stack environment, resolved through the same layers as loadConfig. */
export function resolveRegion(scope: Construct): string {
  const v = buildResolver((k) => scope.node.tryGetContext(k)).get("region");
  return v === undefined || v === null || String(v) === "" ? "ap-northeast-1" : String(v);
}

function dictionaryFields(setting: string): { dictionaryDir: string; dictionaryDirSource: string } {
  const r = resolveDictionary(setting);
  return { dictionaryDir: r.dir, dictionaryDirSource: r.source };
}
const FLAT_LANE_KEYS = ["sourceLanguage", "translateSource", "translateTarget", "pollyVoice"] as const;

// Fills cfg.lanes (and the flat keys for one lane or lane 1 of two). `channels` absent = one lane from the flat keys.
function resolveLanes(cfg: StackConfig, resolver: ReturnType<typeof buildResolver>, channelsRaw: unknown): void {
  const flatLane: LaneSpec = {
    source: cfg.sourceLanguage,
    target: cfg.translateTarget,
    pollyVoice: cfg.pollyVoice,
    transcribeVocabulary: cfg.transcribeVocabularyName,
    translateTerminology: cfg.translateTerminologyName,
  };
  if (channelsRaw === undefined || channelsRaw === null || channelsRaw === "") {
    cfg.lanes = [flatLane];
    return;
  }
  for (const k of FLAT_LANE_KEYS) {
    const src = resolver.source(k);
    if (src === "cli" || src === "event") {
      throw new Error(`channels cannot be combined with "${k}" (set by ${src === "cli" ? "-c" : "event.json"}): put the language and voice in each channel instead`);
    }
  }
  let lanes: LaneSpec[];
  try {
    lanes = resolveChannels(parseChannelsSetting(channelsRaw), {
      languageOptions: cfg.languageOptions.split(",").map((s) => s.trim()).filter(Boolean),
      languageFilter: cfg.languageFilter,
      translateEngine: cfg.translateEngine,
      dictVocabulary: cfg.transcribeVocabularyName,
      dictTerminology: cfg.translateTerminologyName,
    });
  } catch (err) {
    if (err instanceof ChannelsError) throw new Error(err.message);
    throw err;
  }
  cfg.lanes = lanes;
  cfg.twoLanes = lanes.length === 2;
  cfg.channelsUsed = true;
  // Lane 1 = the flat variables (PreferredLanguage, global names); two lanes also get CHANNELS.
  const l1 = lanes[0];
  cfg.sourceLanguage = l1.source;
  cfg.translateSource = l1.source.split("-")[0].toLowerCase();
  cfg.translateTarget = l1.target;
  cfg.pollyVoice = l1.pollyVoice;
  cfg.transcribeVocabularyName = l1.transcribeVocabulary;
  cfg.translateTerminologyName = l1.translateTerminology;
  if (!cfg.twoLanes && l1.translateEngine) cfg.translateEngine = l1.translateEngine;
}

/** True when a lane runs the LLM engine (its own setting, else the global one). */
export function laneUsesLlm(cfg: Pick<StackConfig, "translateEngine">, lane: LaneSpec): boolean {
  return (lane.translateEngine ?? cfg.translateEngine) === "llm";
}

export function loadConfig(scope: Construct): StackConfig {
  const resolver = buildResolver((k) => scope.node.tryGetContext(k));
  const latencyPreset = resolver.profile;
  const ctx = (key: string): unknown => resolver.get(key);
  const ctxStr = (key: string, allowEmpty = false): string => {
    const v = ctx(key);
    if (v === undefined || v === null) {
      if (allowEmpty) return "";
      throw new Error(`Missing context "${key}" (set it in cdk.json or pass -c ${key}=...)`);
    }
    const s = String(v);
    if (!allowEmpty && s.length === 0) throw new Error(`Context "${key}" must not be empty`);
    return s;
  };
  const ctxNum = (key: string): number => {
    const n = Number(ctxStr(key));
    if (!Number.isFinite(n)) throw new Error(`Context "${key}" must be a number, got "${String(ctx(key))}"`);
    return n;
  };
  const ctxPort = (key: string): number => {
    const n = ctxNum(key);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Context "${key}" must be a port 1-65535`);
    return n;
  };

  const cfg: StackConfig = {
    latencyPreset,
    venueCidrs: parseVenueCidrs(ctx("venueCidr")),
    appPath: ctxStr("appPath"),
    srtPort: ctxPort("srtPort"),
    srtLatencyMs: ctxNum("srtLatencyMs"),
    srtListenTimeoutSec: ctxNum("srtListenTimeoutSec"),
    srtAnalyzeMs: ctxNum("srtAnalyzeMs"),
    healthPort: ctxPort("healthPort"),
    sampleRate: ctxNum("sampleRate"),
    frameBytes: ctxNum("frameBytes"),
    sourceLanguage: ctxStr("sourceLanguage"),
    partialStability: ctxStr("partialStability"),
    languageFilter: ctxStr("languageFilter").trim().toLowerCase(),
    languageOptions: ctxStr("languageOptions").trim(),
    langidSettleWords: ctxNum("langidSettleWords"),
    langidSettleMode: ctxStr("langidSettleMode").trim().toLowerCase(),
    langidSettleWordsDefault: ctxNum("langidSettleWordsDefault"),
    langidSettleWordsAfterJa: ctxNum("langidSettleWordsAfterJa"),
    langidJaMemoryMs: ctxNum("langidJaMemoryMs"),
    langidSettleItems: ctxNum("langidSettleItems"),
    langidSettleItemsDefault: ctxNum("langidSettleItemsDefault"),
    langidSettleItemsAfterEn: ctxNum("langidSettleItemsAfterEn"),
    langidShortWords: ctxNum("langidShortWords"),
    langidShortMinConf: ctxNum("langidShortMinConf"),
    jaSegmentationMode: ctxStr("jaSegmentationMode").trim().toLowerCase(),
    jaSentenceMinChars: ctxNum("jaSentenceMinChars"),
    jaClauseMinChars: ctxNum("jaClauseMinChars"),
    jaMaxChars: ctxNum("jaMaxChars"),
    jaPauseMs: ctxNum("jaPauseMs"),
    jaMaxWaitMs: ctxNum("jaMaxWaitMs"),
    jaClauseEndings: ctxStr("jaClauseEndings", true).trim(),
    jaDanglingTokens: ctxStr("jaDanglingTokens", true).trim(),
    jaDanglingMaxChars: ctxNum("jaDanglingMaxChars"),
    jaShortChars: ctxNum("jaShortChars"),
    jaShortMinConf: ctxNum("jaShortMinConf"),
    segmentationMode: ctxStr("segmentationMode"),
    chunkMinWords: ctxNum("chunkMinWords"),
    chunkMaxWords: ctxNum("chunkMaxWords"),
    chunkMaxMs: ctxNum("chunkMaxMs"),
    chunkPauseMs: ctxNum("chunkPauseMs"),
    chunkConjunctions: ctxStr("chunkConjunctions", true).trim(),
    mergeShort: ctxStr("mergeShort").trim().toLowerCase(),
    sentenceMinWords: ctxNum("sentenceMinWords"),
    sentenceCompleteWords: ctxNum("sentenceCompleteWords"),
    mergePauseMs: ctxNum("mergePauseMs"),
    mergeMaxHoldMs: ctxNum("mergeMaxHoldMs"),
    danglingGuard: ctxStr("danglingGuard").trim().toLowerCase(),
    danglingWords: ctxStr("danglingWords", true).trim(),
    danglingMaxWords: ctxNum("danglingMaxWords"),
    danglingMaxHoldMs: ctxNum("danglingMaxHoldMs"),
    cutLookaheadMs: ctxNum("cutLookaheadMs"),
    shortSentenceJoin: ctxStr("shortSentenceJoin").trim().toLowerCase(),
    shortSentenceWords: ctxNum("shortSentenceWords"),
    shortJoinPauseMs: ctxNum("shortJoinPauseMs"),
    speedupSteps: ctxStr("speedupSteps", true).trim(),
    maxBacklogMs: ctxNum("maxBacklogMs"),
    speedMode: ctxStr("speedMode").trim().toLowerCase(),
    speedLevels: ctxStr("speedLevels").trim(),
    speedThresholdsMs: ctxStr("speedThresholdsMs").trim(),
    speedHysteresisMs: ctxNum("speedHysteresisMs"),
    speedHoldMs: ctxNum("speedHoldMs"),
    speedUrgentMs: ctxNum("speedUrgentMs"),
    speedLookahead: ctxNum("speedLookahead"),
    speedMsPerChar: ctxNum("speedMsPerChar"),
    speedResetGapMs: ctxNum("speedResetGapMs"),
    fillerFilter: ctxStr("fillerFilter").trim().toLowerCase(),
    fillerWords: ctxStr("fillerWords", true).trim(),
    fillerPhrases: ctxStr("fillerPhrases", true).trim(),
    jaFillerPatterns: ctxStr("jaFillerPatterns", true).trim(),
    enableCorrection: ctxStr("enableCorrection"),
    translateSource: ctxStr("translateSource"),
    translateTarget: ctxStr("translateTarget"),
    translateFormality: ctxStr("translateFormality").trim(),
    translateEngine: ctxStr("translateEngine").trim().toLowerCase(),
    llmModelId: ctxStr("llmModelId").trim(),
    llmTimeoutMs: ctxNum("llmTimeoutMs"),
    llmContextChunks: ctxNum("llmContextChunks"),
    llmContextResetMs: ctxNum("llmContextResetMs"),
    llmGlossary: ctxStr("llmGlossary").trim().toLowerCase(),
    llmMaxTokens: ctxNum("llmMaxTokens"),
    llmBreakerMs: ctxNum("llmBreakerMs"),
    llmSkipBacklogMs: ctxNum("llmSkipBacklogMs"),
    llmParallelFallback: ctxStr("llmParallelFallback").trim().toLowerCase(),
    llmMaxCharsPerWord: ctxNum("llmMaxCharsPerWord"),
    llmKeepWarmMs: ctxNum("llmKeepWarmMs"),
    llmPromptVersion: ctxNum("llmPromptVersion"),
    transcribeVocabularyName: ctxStr("transcribeVocabularyName", true),
    translateTerminologyName: ctxStr("translateTerminologyName", true),
    pollyVoice: ctxStr("pollyVoice"),
    pollyEngine: ctxStr("pollyEngine"),
    pollySampleRate: ctxNum("pollySampleRate"),
    pollyReadings: ctxStr("pollyReadings").trim().toLowerCase(),
    lanes: [],
    twoLanes: false,
    channelsUsed: false,
    warnings: [],
    ...dictionaryFields(ctxStr("dictionaryDir", true)),
    captions: ctxStr("captions").trim().toLowerCase(),
    captionsJapaneseSpeech: ctxStr("captionsJapaneseSpeech").trim().toLowerCase(),
    roomName: ctxStr("roomName"),
    publisherTokenTtl: ctxStr("publisherTokenTtl"),
    listenerTokenTtlSec: ctxNum("listenerTokenTtlSec"),
    livekitApiKey: ctxStr("livekitApiKey"),
    livekitHostname: ctxStr("livekitHostname", true).trim(),
    livekitInstanceType: ctxStr("livekitInstanceType"),
    livekitImage: ctxStr("livekitImage"),
    caddyImage: ctxStr("caddyImage"),
    livekitUdpPortStart: ctxPort("livekitUdpPortStart"),
    livekitUdpPortEnd: ctxPort("livekitUdpPortEnd"),
    livekitTcpPort: ctxPort("livekitTcpPort"),
    inputSource: ctxStr("inputSource").trim().toLowerCase(),
    rtmpPort: ctxPort("rtmpPort"),
    browserInputConcurrency: ctxNum("browserInputConcurrency"),
    browserInputTokenTtlSec: ctxNum("browserInputTokenTtlSec"),
    browserSessionGraceSec: ctxNum("browserSessionGraceSec"),
    browserAudioProcessing: ctxStr("browserAudioProcessing").trim().toLowerCase(),
    browserSilenceDb: ctxNum("browserSilenceDb"),
    browserSilenceSec: ctxNum("browserSilenceSec"),
    taskCpu: ctxNum("taskCpu"),
    taskMemoryMiB: ctxNum("taskMemoryMiB"),
    desiredCount: ctxNum("desiredCount"),
    logLevel: ctxStr("logLevel"),
    logRetentionDays: ctxNum("logRetentionDays"),
  };

  if (cfg.livekitUdpPortStart > cfg.livekitUdpPortEnd) {
    throw new Error("livekitUdpPortStart must be <= livekitUdpPortEnd");
  }
  if (cfg.segmentationMode !== "clause" && cfg.segmentationMode !== "sentence") {
    throw new Error('segmentationMode must be "clause" or "sentence"');
  }
  if (cfg.languageFilter !== "off" && cfg.languageFilter !== "langid") {
    throw new Error('languageFilter must be "off" or "langid"');
  }
  {
    const codes = cfg.languageOptions.split(",").map((s) => s.trim()).filter(Boolean);
    const prefixes = new Set(codes.map((c) => c.split("-")[0]));
    if (
      codes.length < 2 ||
      codes.length > 5 ||
      !codes.every((c) => /^[a-z]{2,3}-[A-Z]{2}$/.test(c)) ||
      prefixes.size !== codes.length ||
      !codes.includes(cfg.sourceLanguage)
    ) {
      throw new Error(
        `languageOptions must be 2-5 comma-separated language codes (e.g. "en-US,ja-JP"), one per language, including sourceLanguage (${cfg.sourceLanguage})`,
      );
    }
    cfg.languageOptions = codes.join(",");
  }
  intRangeEarly(cfg, "langidSettleItems", 1, 50);
  intRangeEarly(cfg, "langidSettleItemsDefault", 1, 50);
  intRangeEarly(cfg, "langidSettleItemsAfterEn", 1, 50);
  if (cfg.jaSegmentationMode !== "simple" && cfg.jaSegmentationMode !== "full") {
    throw new Error('jaSegmentationMode must be "simple" or "full"');
  }
  intRangeEarly(cfg, "jaSentenceMinChars", 1, 200);
  intRangeEarly(cfg, "jaClauseMinChars", 1, 200);
  intRangeEarly(cfg, "jaMaxChars", 4, 400);
  intRangeEarly(cfg, "jaPauseMs", 0, 60000, " (0 disables)");
  intRangeEarly(cfg, "jaMaxWaitMs", 0, 60000, " (0 disables)");
  intRangeEarly(cfg, "jaDanglingMaxChars", 0, 100);
  intRangeEarly(cfg, "jaShortChars", 0, 50, " (0 disables the Japanese short-low-confidence rule)");
  if (cfg.jaShortMinConf < 0 || cfg.jaShortMinConf > 1) throw new Error("jaShortMinConf must be a number 0-1");
  {
    const list = (key: "jaClauseEndings" | "jaDanglingTokens"): string[] => {
      const v = cfg[key];
      if (v === "") return [];
      if (/[\s]/.test(v) || /(^,|,,|,$)/.test(v)) throw new Error(`${key} must be a comma list of tokens without spaces, or "" for the built-in list`);
      return v.split(",");
    };
    const endings = list("jaClauseEndings");
    const dangling = list("jaDanglingTokens");
    const overlap = endings.filter((e) => dangling.includes(e));
    if (overlap.length > 0) {
      throw new Error(`jaClauseEndings and jaDanglingTokens share an entry (${overlap.join(",")}); the two lists must not overlap`);
    }
  }
  if (!Number.isInteger(cfg.langidSettleWords) || cfg.langidSettleWords < 1 || cfg.langidSettleWords > 50) {
    throw new Error("langidSettleWords must be an integer 1-50");
  }
  if (cfg.langidSettleMode !== "fixed" && cfg.langidSettleMode !== "dynamic") {
    throw new Error('langidSettleMode must be "fixed" or "dynamic" (case-insensitive)');
  }
  intRangeEarly(cfg, "langidSettleWordsDefault", 1, 50);
  intRangeEarly(cfg, "langidSettleWordsAfterJa", 1, 50);
  intRangeEarly(cfg, "langidJaMemoryMs", 0, 600000);
  if (!Number.isInteger(cfg.langidShortWords) || cfg.langidShortWords < 0 || cfg.langidShortWords > 20) {
    throw new Error("langidShortWords must be an integer 0-20 (0 disables the short-low-confidence rule)");
  }
  if (cfg.langidShortMinConf < 0 || cfg.langidShortMinConf > 1) {
    throw new Error("langidShortMinConf must be a number 0-1");
  }
  for (const key of ["chunkMinWords", "chunkMaxWords", "chunkMaxMs", "chunkPauseMs", "maxBacklogMs"] as const) {
    if (cfg[key] < 0) throw new Error(`${key} must be >= 0`);
  }
  if (cfg.chunkMinWords < 1 || !Number.isInteger(cfg.chunkMinWords)) throw new Error("chunkMinWords must be an integer >= 1");
  if (!Number.isInteger(cfg.chunkMaxWords) || cfg.chunkMaxWords < cfg.chunkMinWords) {
    throw new Error("chunkMaxWords must be an integer >= chunkMinWords");
  }
  if (cfg.mergeShort !== "on" && cfg.mergeShort !== "off") throw new Error('mergeShort must be "on" or "off"');
  if (!Number.isInteger(cfg.sentenceMinWords) || cfg.sentenceMinWords < 1 || cfg.sentenceMinWords > 100) {
    throw new Error("sentenceMinWords must be an integer 1-100");
  }
  // Values >= sentenceMinWords have no effect (such a sentence is cut anyway); allowed, documented.
  if (!Number.isInteger(cfg.sentenceCompleteWords) || cfg.sentenceCompleteWords < 0 || cfg.sentenceCompleteWords > 100) {
    throw new Error("sentenceCompleteWords must be an integer 0-100 (0 disables)");
  }
  if (!Number.isInteger(cfg.mergePauseMs) || cfg.mergePauseMs < 0 || cfg.mergePauseMs > 60000) {
    throw new Error("mergePauseMs must be an integer 0-60000 (0 disables)");
  }
  if (!Number.isInteger(cfg.mergeMaxHoldMs) || cfg.mergeMaxHoldMs < 1000 || cfg.mergeMaxHoldMs > 60000) {
    throw new Error("mergeMaxHoldMs must be an integer 1000-60000 (safety valve; cannot be disabled)");
  }
  if (cfg.danglingGuard !== "on" && cfg.danglingGuard !== "off") throw new Error('danglingGuard must be "on" or "off"');
  if (cfg.danglingWords !== "" && !/^[^\s,]+(,[^\s,]+)*$/.test(cfg.danglingWords)) {
    throw new Error('danglingWords must be a comma list of words without spaces (e.g. "the,of,to"), or "" for the built-in list');
  }
  if (!Number.isInteger(cfg.danglingMaxWords) || cfg.danglingMaxWords < 0 || cfg.danglingMaxWords > 20) {
    throw new Error("danglingMaxWords must be an integer 0-20");
  }
  if (!Number.isInteger(cfg.danglingMaxHoldMs) || cfg.danglingMaxHoldMs < 0 || cfg.danglingMaxHoldMs > 10000) {
    throw new Error("danglingMaxHoldMs must be an integer 0-10000");
  }
  if (!Number.isInteger(cfg.cutLookaheadMs) || cfg.cutLookaheadMs < 0 || cfg.cutLookaheadMs > 5000) {
    throw new Error("cutLookaheadMs must be an integer 0-5000 (0 disables)");
  }
  if (cfg.shortSentenceJoin !== "on" && cfg.shortSentenceJoin !== "off") throw new Error('shortSentenceJoin must be "on" or "off"');
  if (!Number.isInteger(cfg.shortSentenceWords) || cfg.shortSentenceWords < 1 || cfg.shortSentenceWords > 6) {
    throw new Error("shortSentenceWords must be an integer 1-6");
  }
  if (!Number.isInteger(cfg.shortJoinPauseMs) || cfg.shortJoinPauseMs < 0 || cfg.shortJoinPauseMs > 10000) {
    throw new Error("shortJoinPauseMs must be an integer 0-10000 (0 = use mergePauseMs)");
  }
  if (!["FORMAL", "INFORMAL", "off"].includes(cfg.translateFormality)) {
    throw new Error('translateFormality must be "FORMAL", "INFORMAL" or "off"');
  }
  if (cfg.translateEngine !== "translate" && cfg.translateEngine !== "llm") {
    throw new Error('translateEngine must be "translate" or "llm"');
  }
  resolveLanes(cfg, resolver, ctx("channels"));
  if (cfg.lanes.some((l) => laneUsesLlm(cfg, l))) {
    // IAM scoping in the stack is only defined for the Japan cross-Region inference profile (jp.*).
    if (!/^jp\.[a-z0-9][a-z0-9.-]*(:\d+)?$/.test(cfg.llmModelId)) {
      throw new Error(
        `llmModelId must be a Japan inference profile id starting with "jp." (e.g. "jp.anthropic.claude-haiku-4-5-20251001-v1:0") when translateEngine=llm. Got: "${cfg.llmModelId}"`,
      );
    }
    if (cfg.translateEngine === "llm" && cfg.translateTerminologyName.trim().length === 0) {
      throw new Error(
        "translateEngine=llm needs a non-empty translateTerminologyName (the LLM glossary is loaded from the Translate terminology)",
      );
    }
  }
  if (cfg.pollyReadings !== "on" && cfg.pollyReadings !== "off") throw new Error('pollyReadings must be "on" or "off"');
  if (cfg.captions !== "on" && cfg.captions !== "off") throw new Error('captions must be "on" or "off"');
  if (cfg.captionsJapaneseSpeech !== "on" && cfg.captionsJapaneseSpeech !== "off") {
    throw new Error('captionsJapaneseSpeech must be "on" or "off"');
  }
  if (cfg.llmGlossary !== "full" && cfg.llmGlossary !== "off") throw new Error('llmGlossary must be "full" or "off"');
  if (cfg.llmParallelFallback !== "on" && cfg.llmParallelFallback !== "off") {
    throw new Error('llmParallelFallback must be "on" or "off"');
  }
  intRangeEarly(cfg, "llmTimeoutMs", 200, 10000);
  intRangeEarly(cfg, "llmContextChunks", 0, 6);
  intRangeEarly(cfg, "llmContextResetMs", 0, 600000, " (0 = never reset)");
  intRangeEarly(cfg, "llmMaxTokens", 48, 1000);
  intRangeEarly(cfg, "llmBreakerMs", 1000, 600000);
  intRangeEarly(cfg, "llmSkipBacklogMs", 0, 60000, " (0 disables)");
  intRangeEarly(cfg, "llmMaxCharsPerWord", 4, 40);
  if (cfg.llmPromptVersion !== 1 && cfg.llmPromptVersion !== 2) throw new Error("llmPromptVersion must be 1 or 2");
  if (cfg.llmKeepWarmMs !== 0 && (!Number.isInteger(cfg.llmKeepWarmMs) || cfg.llmKeepWarmMs < 30000 || cfg.llmKeepWarmMs > 290000)) {
    throw new Error("llmKeepWarmMs must be 0 (off) or an integer 30000-290000 (the prompt cache lives 5 minutes)");
  }
  if (!/^(off|0|)$/i.test(cfg.speedupSteps)) {
    for (const part of cfg.speedupSteps.split(",")) {
      const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(part);
      if (!m || Number(m[2]) < 100 || Number(m[2]) > 200) {
        throw new Error('speedupSteps must be "backlogMs:ratePercent,..." with rate 100-200 (e.g. "3000:115,5000:130,7000:150"), or "off"');
      }
    }
  }
  if (!["levels", "steps", "off"].includes(cfg.speedMode)) {
    throw new Error('speedMode must be "levels", "steps" (old speedupSteps behavior) or "off"');
  }
  const levels = cfg.speedLevels.split(",").map((s) => s.trim());
  if (
    levels.length < 2 ||
    levels.length > 10 ||
    !levels.every((s, i) => /^\d+$/.test(s) && Number(s) >= 100 && Number(s) <= 200 && (i === 0 || Number(s) > Number(levels[i - 1])))
  ) {
    throw new Error('speedLevels must be 2-10 strictly ascending integers 100-200 (e.g. "100,110,120,130,145")');
  }
  const thresholds = cfg.speedThresholdsMs.split(",").map((s) => s.trim());
  if (
    thresholds.length !== levels.length - 1 ||
    !thresholds.every((s, i) => /^\d+$/.test(s) && Number(s) <= 60000 && (i === 0 || Number(s) > Number(thresholds[i - 1])))
  ) {
    throw new Error(
      `speedThresholdsMs must be ${levels.length - 1} strictly ascending integers 0-60000 (one per speed level above L1, e.g. "3000,4500,6000,7500")`,
    );
  }
  const intRange = (key: keyof StackConfig, min: number, max: number, note = "") => {
    const v = cfg[key] as number;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} must be an integer ${min}-${max}${note}`);
  };
  intRange("speedHysteresisMs", 0, 10000);
  intRange("speedHoldMs", 0, 60000);
  intRange("speedUrgentMs", 0, 120000, " (0 disables the urgent bypass)");
  intRange("speedMsPerChar", 20, 1000);
  intRange("speedResetGapMs", 0, 60000, " (0 disables)");
  if (cfg.speedLookahead < 0 || cfg.speedLookahead > 2) throw new Error("speedLookahead must be a number 0-2 (0 disables)");
  if (cfg.fillerFilter !== "on" && cfg.fillerFilter !== "off") throw new Error('fillerFilter must be "on" or "off"');
  if (cfg.fillerWords && !/^[A-Za-z' ,-]+$/.test(cfg.fillerWords)) {
    throw new Error("fillerWords must be a comma-separated list of words");
  }
  if (cfg.fillerPhrases && !/^[A-Za-z' ,-]+$/.test(cfg.fillerPhrases)) {
    throw new Error("fillerPhrases must be a comma-separated list of words/phrases");
  }
  if (cfg.chunkConjunctions && !/^[A-Za-z' ,-]+$/.test(cfg.chunkConjunctions)) {
    throw new Error("chunkConjunctions must be a comma-separated list of words");
  }
  if (cfg.srtPort === cfg.healthPort) throw new Error("srtPort and healthPort must differ");
  if (!Number.isInteger(cfg.srtAnalyzeMs) || cfg.srtAnalyzeMs < 0 || cfg.srtAnalyzeMs > 10000) {
    throw new Error("srtAnalyzeMs must be an integer 0-10000 (0 = ffmpeg default probing, ~5 s)");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cfg.livekitApiKey)) throw new Error("livekitApiKey must be alphanumeric/_/-");
  if (!/^[A-Za-z0-9_-]+$/.test(cfg.roomName)) throw new Error("roomName must be alphanumeric/_/-");
  if (cfg.livekitHostname && !/^[A-Za-z0-9.-]+$/.test(cfg.livekitHostname)) {
    throw new Error("livekitHostname must be a plain DNS name");
  }
  // Browser microphone input. All ranges are checked even when inputSource=srt, so a typo shows up early.
  if (!["srt", "browser", "rtmps"].includes(cfg.inputSource)) throw new Error('inputSource must be "srt", "browser" or "rtmps"');
  // RTMPS input. The port is checked even when inputSource is not rtmps, so a typo shows up early.
  for (const [name, port] of [["srtPort", cfg.srtPort], ["healthPort", cfg.healthPort], ["livekitTcpPort", cfg.livekitTcpPort]] as const) {
    if (cfg.rtmpPort === port) throw new Error(`rtmpPort must differ from ${name} (${port})`);
  }
  if (cfg.rtmpPort === 443 || cfg.rtmpPort === 7880) throw new Error("rtmpPort must not be 443 or 7880 (Caddy and LiveKit signaling)");
  if (cfg.inputSource === "rtmps" && cfg.livekitHostname) {
    throw new Error("inputSource=rtmps needs livekitHostname empty: the RTMPS name rtmps.<LiveKit IP>.sslip.io exists only with the sslip.io host");
  }
  if (cfg.inputSource === "rtmps" && cfg.venueCidrs.length === 0) throw new Error("inputSource=rtmps needs venueCidr (Caddy admits only those addresses)");
  intRangeEarly(cfg, "browserInputConcurrency", 1, 1000, " (0 is not allowed: the reserved concurrency is the brute-force throttle of the publisher endpoint)");
  intRangeEarly(cfg, "browserInputTokenTtlSec", 60, 3600);
  intRangeEarly(cfg, "browserSessionGraceSec", 10, 600);
  if (!["all", "echo", "none"].includes(cfg.browserAudioProcessing)) throw new Error('browserAudioProcessing must be "all", "echo" or "none"');
  if (cfg.browserSilenceDb < -120 || cfg.browserSilenceDb > 0) throw new Error("browserSilenceDb must be a number from -120 to 0");
  intRangeEarly(cfg, "browserSilenceSec", 5, 600);
  if (cfg.roomName.endsWith("-ingest")) {
    throw new Error('roomName must not end in "-ingest": that suffix is reserved for the browser ingest room (<roomName>-ingest)');
  }
  // A Japanese-source lane without a Transcribe vocabulary while the dictionary folder has a generated Japanese one:
  // a warning (printed at synth), not an error.
  if (existsSync(join(cfg.dictionaryDir, "transcribe-vocabulary-ja.txt"))) {
    cfg.lanes.forEach((l, i) => {
      if (/^ja-/.test(l.source) && l.transcribeVocabulary === "") {
        cfg.warnings.push(
          `lane ${i + 1} (${l.source} to ${l.target}) has no transcribeVocabulary, but ${cfg.dictionaryDir} has transcribe-vocabulary-ja.txt. ` +
            `Set "transcribeVocabulary" on that channel to the name dictionaries.sh uploads it as (<transcribeVocabulary>-ja) so Transcribe uses it.`,
        );
      }
    });
  }
  return cfg;
}
