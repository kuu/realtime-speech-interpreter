import { fileURLToPath } from "node:url";
import { LANGID_JA_MEMORY_MS, LANGID_SETTLE_WORDS_AFTER_JA, LANGID_SETTLE_WORDS_DEFAULT } from "./langid-defaults.js";
// Centralized configuration. Every venue/account/language-specific value is
// externalized via environment variables so the app can be reused without code
// changes. Secrets (SRT passphrase, LiveKit API secret) come from the environment
// or AWS Secrets Manager and are never committed.

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined ? def : Number(v);
}
function str(name: string, def: string): string {
  return process.env[name] ?? def;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true";
}
// Validated number: unset/empty → default; non-finite, negative or out of range →
// default plus a warning (a typo at deploy time must not break the pipeline).
// (console is used because log.ts depends on this module.)
function safeNum(name: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`${new Date().toISOString()} WARN [config] ${name}="${v}" invalid (allowed ${min}-${max}); using default ${def}`);
    return def;
  }
  return n;
}
function oneOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  const hit = matchAllowed(v, allowed);
  if (hit !== undefined) return hit;
  console.error(`${new Date().toISOString()} WARN [config] ${name}="${v}" invalid (allowed ${allowed.join("|")}); using default ${def}`);
  return def;
}
// Case-insensitive match that returns the canonical (declared) spelling. The allowed lists mix
// lower case ("langid") and upper case ("FORMAL"), so lower-casing the input and comparing it
// with the list rejected every upper-case entry.
function matchAllowed<T extends string>(raw: string, allowed: readonly T[]): T | undefined {
  const s = raw.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === s);
}

// Comma-separated list; unset → default, "" → empty list.
function list(name: string, def: string): string[] {
  return str(name, def)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---- LLM translation engine (optional; see translate-engine.ts) ----------------------------
// Pure parsers over an env object so they are unit-testable (config.ts reads process.env at import).
export type TranslateEngineName = "translate" | "llm";
export interface LlmConfig {
  modelId: string;
  timeoutMs: number;
  contextChunks: number;
  contextResetMs: number;
  glossary: "full" | "off";
  maxTokens: number;
  breakerMs: number;
  skipBacklogMs: number;
  parallelFallback: boolean;
  maxCharsPerWord: number;
  keepWarmMs: number;
  // 1 = benchmarked prompt (llm-translate); 2 = adds <chunk_ends_sentence> so early cuts stay unfinished.
  promptVersion: 1 | 2;
}
export const DEFAULT_LLM_PROMPT_VERSION = 2;
export const DEFAULT_LLM_MODEL_ID = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";

function envWarn(name: string, v: string, allowed: string, def: unknown): void {
  console.error(`${new Date().toISOString()} WARN [config] ${name}="${v}" invalid (allowed ${allowed}); using default ${def}`);
}
function envNum(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    envWarn(name, v, `${min}-${max}`, def);
    return def;
  }
  return n;
}
function envOneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, def: T, allowed: readonly T[]): T {
  const v = env[name];
  if (v === undefined || v.trim() === "") return def;
  const hit = matchAllowed(v, allowed);
  if (hit !== undefined) return hit;
  envWarn(name, v, allowed.join("|"), def);
  return def;
}
export function pollyReadings(env: NodeJS.ProcessEnv): "on" | "off" {
  return envOneOf(env, "POLLY_READINGS", "on", ["on", "off"] as const);
}
export function captions(env: NodeJS.ProcessEnv): "on" | "off" {
  return envOneOf(env, "CAPTIONS", "on", ["on", "off"] as const);
}
export function captionsJapaneseSpeech(env: NodeJS.ProcessEnv): "on" | "off" {
  return envOneOf(env, "CAPTIONS_JA_SPEECH", "on", ["on", "off"] as const);
}
export function translateEngine(env: NodeJS.ProcessEnv): TranslateEngineName {
  return envOneOf(env, "TRANSLATE_ENGINE", "translate", ["translate", "llm"] as const);
}
export function llmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const modelRaw = env.LLM_MODEL_ID;
  let modelId = DEFAULT_LLM_MODEL_ID;
  if (modelRaw !== undefined && modelRaw.trim() !== "") modelId = modelRaw.trim();
  else if (modelRaw !== undefined) envWarn("LLM_MODEL_ID", modelRaw, "non-empty model id", DEFAULT_LLM_MODEL_ID);
  // 0 = off, otherwise 30000-290000 (the prompt cache lives 5 minutes).
  let keepWarmMs = 240000;
  const kw = env.LLM_KEEPWARM_MS;
  if (kw !== undefined && kw.trim() !== "") {
    const n = Number(kw);
    if (Number.isFinite(n) && (n === 0 || (n >= 30000 && n <= 290000))) keepWarmMs = n;
    else envWarn("LLM_KEEPWARM_MS", kw, "0 or 30000-290000", keepWarmMs);
  }
  return {
    modelId,
    timeoutMs: envNum(env, "LLM_TIMEOUT_MS", 1500, 200, 10000),
    contextChunks: envNum(env, "LLM_CONTEXT_CHUNKS", 3, 0, 6),
    contextResetMs: envNum(env, "LLM_CONTEXT_RESET_MS", 60000, 0, 600000),
    glossary: envOneOf(env, "LLM_GLOSSARY", "full", ["full", "off"] as const),
    maxTokens: envNum(env, "LLM_MAX_TOKENS", 400, 48, 1000),
    breakerMs: envNum(env, "LLM_BREAKER_MS", 30000, 1000, 600000),
    skipBacklogMs: envNum(env, "LLM_SKIP_BACKLOG_MS", 0, 0, 60000),
    parallelFallback: envOneOf(env, "LLM_PARALLEL_FALLBACK", "off", ["off", "on"] as const) === "on",
    maxCharsPerWord: envNum(env, "LLM_MAX_CHARS_PER_WORD", 15, 4, 40),
    keepWarmMs,
    promptVersion: envNum(env, "LLM_PROMPT_VERSION", DEFAULT_LLM_PROMPT_VERSION, 1, 2) === 1 ? 1 : 2,
  };
}
export type TranslateFormality = "FORMAL" | "INFORMAL" | "off";
// Politeness of the Translate output (Settings.Formality). Case-insensitive; invalid -> FORMAL with a WARN.
export function translateFormality(env: NodeJS.ProcessEnv): TranslateFormality {
  return envOneOf<TranslateFormality>(env, "TRANSLATE_FORMALITY", "FORMAL", ["FORMAL", "INFORMAL", "off"]);
}

export interface LangidSettleConfig {
  settleMode: "fixed" | "dynamic";
  settleWordsDefault: number;
  settleWordsAfterJa: number;
  jaMemoryMs: number;
}
// Dynamic language-ID settle (see language-gate.ts). Invalid values fall back to the default with a WARN.
export function langidSettleConfig(env: NodeJS.ProcessEnv): LangidSettleConfig {
  return {
    settleMode: envOneOf(env, "LANGID_SETTLE_MODE", "fixed", ["fixed", "dynamic"] as const),
    settleWordsDefault: envNum(env, "LANGID_SETTLE_WORDS_DEFAULT", LANGID_SETTLE_WORDS_DEFAULT, 1, 50),
    settleWordsAfterJa: envNum(env, "LANGID_SETTLE_WORDS_AFTER_JA", LANGID_SETTLE_WORDS_AFTER_JA, 1, 50),
    jaMemoryMs: envNum(env, "LANGID_JA_MEMORY_MS", LANGID_JA_MEMORY_MS, 0, 600000),
  };
}

export interface SpeedupStep {
  backlogMs: number;
  rate: number; // percent, 100-200
}
const DEFAULT_SPEEDUP_STEPS = "3000:115,5000:130,7000:150";
export function parseSpeedupSteps(raw: string): SpeedupStep[] | null {
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "off" || s === "0") return [];
  const steps: SpeedupStep[] = [];
  for (const part of s.split(",")) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(part);
    if (!m) return null;
    const step = { backlogMs: Number(m[1]), rate: Number(m[2]) };
    if (step.rate < 100 || step.rate > 200) return null;
    steps.push(step);
  }
  return steps.sort((a, b) => a.backlogMs - b.backlogMs);
}
function speedupSteps(name: string, def: string): SpeedupStep[] {
  const v = process.env[name];
  if (v === undefined) return parseSpeedupSteps(def) as SpeedupStep[];
  const parsed = parseSpeedupSteps(v);
  if (parsed) return parsed;
  console.error(`${new Date().toISOString()} WARN [config] ${name}="${v}" invalid (format "ms:rate,..." rate 100-200, or "off"); using default ${def}`);
  return parseSpeedupSteps(def) as SpeedupStep[];
}

// Speed levels "100,110,120,130,145": 2-10 integers 100-200, strictly ascending. null when invalid.
export function parseSpeedLevels(raw: string): number[] | null {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length < 2 || parts.length > 10) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 100 || v > 200) return null;
    if (out.length > 0 && v <= out[out.length - 1]) return null;
    out.push(v);
  }
  return out;
}
// Thresholds "3000,4500,6000,7500": exactly nLevels-1 integers 0-60000, strictly ascending.
export function parseSpeedThresholds(raw: string, nLevels: number): number[] | null {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== nLevels - 1) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v > 60000) return null;
    if (out.length > 0 && v <= out[out.length - 1]) return null;
    out.push(v);
  }
  return out;
}
const DEFAULT_SPEED_LEVELS = "100,110,120,130,145";
const DEFAULT_SPEED_THRESHOLDS_MS = "3000,4500,6000,7500";
function speedLevelMap(): { levels: number[]; thresholdsMs: number[] } {
  const rawL = str("SPEED_LEVELS", DEFAULT_SPEED_LEVELS);
  const rawT = str("SPEED_THRESHOLDS_MS", DEFAULT_SPEED_THRESHOLDS_MS);
  const levels = parseSpeedLevels(rawL);
  const thresholdsMs = levels ? parseSpeedThresholds(rawT, levels.length) : null;
  if (levels && thresholdsMs) return { levels, thresholdsMs };
  console.error(
    `${new Date().toISOString()} WARN [config] SPEED_LEVELS="${rawL}" / SPEED_THRESHOLDS_MS="${rawT}" invalid ` +
      `(levels: 2-10 ascending integers 100-200; thresholds: levels-1 ascending integers 0-60000); ` +
      `using defaults ${DEFAULT_SPEED_LEVELS} / ${DEFAULT_SPEED_THRESHOLDS_MS}`,
  );
  return {
    levels: parseSpeedLevels(DEFAULT_SPEED_LEVELS) as number[],
    thresholdsMs: parseSpeedThresholds(DEFAULT_SPEED_THRESHOLDS_MS, 5) as number[],
  };
}

// Language-ID options "en-US,ja-JP": 2-5 codes like xx-XX, unique language prefixes,
// must include the source language. Returns null when invalid.
export function parseLanguageOptions(raw: string, source: string): string[] | null {
  const codes = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (codes.length < 2 || codes.length > 5) return null;
  if (!codes.every((c) => /^[a-z]{2,3}-[A-Z]{2}$/.test(c))) return null;
  const prefixes = new Set(codes.map((c) => c.split("-")[0]));
  if (prefixes.size !== codes.length) return null;
  if (!codes.includes(source)) return null;
  return codes;
}

const SOURCE_LANGUAGE = str("SOURCE_LANGUAGE", "en-US");
const DEFAULT_LANGUAGE_OPTIONS = "en-US,ja-JP";

function languageFilter(): {
  mode: "off" | "langid";
  options: string[];
  settleWords: number;
  settleMode: "fixed" | "dynamic";
  settleWordsDefault: number;
  settleWordsAfterJa: number;
  jaMemoryMs: number;
  shortWords: number;
  shortMinConf: number;
} {
  let mode = oneOf("LANGUAGE_FILTER", "langid", ["off", "langid"] as const);
  const raw = str("LANGUAGE_OPTIONS", DEFAULT_LANGUAGE_OPTIONS);
  let options = parseLanguageOptions(raw, SOURCE_LANGUAGE);
  if (!options) {
    const def = parseLanguageOptions(DEFAULT_LANGUAGE_OPTIONS, SOURCE_LANGUAGE);
    if (def) {
      console.error(
        `${new Date().toISOString()} WARN [config] LANGUAGE_OPTIONS="${raw}" invalid (2-5 codes like en-US, unique languages, must include ${SOURCE_LANGUAGE}); using default ${DEFAULT_LANGUAGE_OPTIONS}`,
      );
      options = def;
    } else {
      if (mode !== "off") {
        console.error(
          `${new Date().toISOString()} WARN [config] LANGUAGE_OPTIONS="${raw}" invalid and default does not include SOURCE_LANGUAGE=${SOURCE_LANGUAGE}; LANGUAGE_FILTER forced to off`,
        );
      }
      mode = "off";
      options = [];
    }
  }
  return {
    mode,
    options,
    // Commit a source-language result only once its stable prefix has this many words
    // (protects against a language flip at the start of a result).
    settleWords: safeNum("LANGID_SETTLE_WORDS", 5, 1, 50),
    // LANGID_SETTLE_MODE=fixed: LANGID_SETTLE_WORDS for every result. dynamic: LANGID_SETTLE_WORDS_DEFAULT (3) unless a
    // non-source (ja-JP) result was seen in the last LANGID_JA_MEMORY_MS, then LANGID_SETTLE_WORDS_AFTER_JA (5).
    ...langidSettleConfig(process.env),
    // Drop short low-confidence source-language finals right after a non-source final. 0 disables.
    shortWords: safeNum("LANGID_SHORT_WORDS", 4, 0, 20),
    shortMinConf: safeNum("LANGID_SHORT_MIN_CONF", 0.6, 0, 1),
  };
}

const DEFAULT_CONJUNCTIONS =
  "and,but,so,because,which,who,where,when,while,although,though,if,unless,or,then";

const chunkMinWords = safeNum("CHUNK_MIN_WORDS", 5, 1, 100);
const chunkMaxWordsRaw = safeNum("CHUNK_MAX_WORDS", 14, 1, 200);
const chunkMaxWords = chunkMaxWordsRaw < chunkMinWords ? chunkMinWords : chunkMaxWordsRaw;
if (chunkMaxWordsRaw < chunkMinWords) {
  console.error(`${new Date().toISOString()} WARN [config] CHUNK_MAX_WORDS < CHUNK_MIN_WORDS; using ${chunkMinWords}`);
}

const SPEEDUP_STEPS = speedupSteps("SPEEDUP_STEPS", DEFAULT_SPEEDUP_STEPS);

export const config = {
  region: str("AWS_REGION", "ap-northeast-1"),
  // Informational only: the CDK latencyPreset the task was deployed with (the preset itself is applied
  // at synth time, so the other settings already carry its values). Echoed in the startup log.
  latencyPreset: str("LATENCY_PRESET", "default"),
  logLevel: str("LOG_LEVEL", "info"),

  // Path to an ffmpeg binary WITH SRT + Opus support. The default relies on PATH;
  // on macOS the plain Homebrew `ffmpeg` lacks SRT — use `ffmpeg-full` and point
  // FFMPEG_PATH at it (e.g. /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg). The Docker
  // image's ffmpeg includes SRT, so the PATH default is fine in production.
  ffmpegPath: str("FFMPEG_PATH", "ffmpeg"),

  // SRT ingest: the app is the SRT listener; OBS connects as caller.
  srt: {
    // Bind address. Loopback by default (a local run must not listen on every interface);
    // the Fargate task sets SRT_HOST=0.0.0.0 explicitly (awsvpc; security groups are the boundary).
    listenHost: str("SRT_HOST", "127.0.0.1"),
    listenPort: num("SRT_PORT", 9000),
    latencyMs: num("SRT_LATENCY_MS", 120),
    // How long the SRT listener waits for a caller before ffmpeg gives up.
    // Large default so the app keeps listening until OBS/the mic sender connects.
    listenTimeoutSec: num("SRT_LISTEN_TIMEOUT_SEC", 3600),
    passphrase: str("SRT_PASSPHRASE", ""), // secret; empty = none (test only)
    // ffmpeg input probing of the SRT stream (-analyzeduration, ms). ffmpeg's default (~5 s)
    // holds the first seconds of every connection and releases them as a burst, which a
    // language-ID Transcribe stream keeps as a permanent lag. 0 = ffmpeg default (revert).
    analyzeMs: safeNum("SRT_ANALYZE_MS", 500, 0, 10000),
  },

  // Audio decoded from SRT and sent to Transcribe (validated: 16 kHz mono s16le).
  audio: {
    sampleRateHertz: num("SAMPLE_RATE", 16000),
    channels: 1,
    frameBytes: num("FRAME_BYTES", 3200), // Transcribe frame size (~100ms)
  },

  transcribe: {
    languageCode: SOURCE_LANGUAGE,
    vocabularyName: str("TRANSCRIBE_VOCABULARY", ""),
    partialResultsStability: str("PARTIAL_STABILITY", "high"),
  },

  // Ignore non-source-language speech (see language-gate.ts).
  //   langid = Transcribe multi-language identification (LANGUAGE_OPTIONS); only results
  //            identified as SOURCE_LANGUAGE reach the segmenter
  //   off    = revert switch: single-language en-US stream, everything is translated (old behavior)
  languageFilter: languageFilter(),

  // Segmentation of the English transcript into translation chunks (see segmenter.ts).
  //   clause   = mid-sentence chunks (commas, conjunctions, max words/time, pause)
  //   sentence = revert switch: translate whole sentences (higher latency, best grammar);
  //              use with MAX_BACKLOG_MS=0 or whole sentences get dropped under sustained speech
  segmentation: {
    mode: oneOf("SEGMENTATION_MODE", "clause", ["clause", "sentence"] as const),
    // Min words (fillers like "um" excluded) before a comma/conjunction/max-time cut.
    minWords: chunkMinWords,
    // Hard cap on words per chunk (clause mode).
    maxWords: chunkMaxWords,
    // Flush once the chunk has been open this long and has >= minWords. 0 disables.
    maxMs: safeNum("CHUNK_MAX_MS", 3000),
    // Flush pending stable text after this long with no new transcript activity. 0 disables.
    pauseMs: safeNum("CHUNK_PAUSE_MS", 1200),
    // Cut BEFORE these words once >= minWords have accumulated.
    conjunctions: str("CHUNK_CONJUNCTIONS", DEFAULT_CONJUNCTIONS)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    // Merge short sentences (clause mode only): a sentence end / final that would give a chunk
    // with < sentenceMinWords words is held and joined with the following text. "off" = revert.
    mergeShort: oneOf("MERGE_SHORT", "on", ["on", "off"] as const) === "on",
    sentenceMinWords: safeNum("SENTENCE_MIN_WORDS", 8, 1, 100),
    // Release held text after this long with no new transcript activity. 0 disables.
    mergePauseMs: safeNum("MERGE_PAUSE_MS", 1500, 0, 60000),
    // Safety valve: release held text once its oldest word is this old (min 1000, can't be disabled).
    mergeMaxHoldMs: safeNum("MERGE_MAX_HOLD_MS", 6000, 1000, 60000),
    // Merge on: a .?! ending a sentence of >= this many words is cut at once even when the chunk
    // has < sentenceMinWords (a complete sentence is never held; only fragments merge). 0 = revert.
    sentenceCompleteWords: safeNum("SENTENCE_COMPLETE_WORDS", 5, 0, 100),
    // quality-v1 part B (defaults chosen by replay, measured on recorded streams).
    // Dangling-end guard: never end a chunk on a preposition, article, relative pronoun, conjunction or
    // auxiliary ("... in", "... that"). Comma/conjunction/max-words cuts skip such a word (max-words may
    // run DANGLING_MAX_WORDS over); pause/final cuts wait at most DANGLING_MAX_HOLD_MS. off = revert.
    danglingGuard: oneOf("DANGLING_GUARD", "on", ["on", "off"] as const) === "on",
    // Comma list of words that dangle; empty = the built-in list (DEFAULT_DANGLING_WORDS).
    danglingWords: str("DANGLING_WORDS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    danglingMaxWords: safeNum("DANGLING_MAX_WORDS", 2, 0, 20),
    danglingMaxHoldMs: safeNum("DANGLING_MAX_HOLD_MS", 500, 0, 10000),
    // Look-ahead: a pause/final cut that ends mid-sentence waits this long for the next words. 0 = off.
    cutLookaheadMs: safeNum("CUT_LOOKAHEAD_MS", 0, 0, 5000),
    // Short-sentence join: tiny held sentences wait SHORT_JOIN_PAUSE_MS (0 = MERGE_PAUSE_MS) and are
    // comma-joined in the English sent to Translate ("There's small, Medium, and large."). off = revert.
    shortSentenceJoin: oneOf("SHORT_SENTENCE_JOIN", "on", ["on", "off"] as const) === "on",
    shortSentenceWords: safeNum("SHORT_SENTENCE_WORDS", 3, 1, 6),
    shortJoinPauseMs: safeNum("SHORT_JOIN_PAUSE_MS", 1000, 0, 10000),
  },

  // Local INPUT_FILE feed only (not used with SRT): how the file is paced to real time.
  //   absolute = frame k is sent at start + k * frameMs (no drift)
  //   sleep    = revert: sleep(frameMs) after each frame (drifts ~1 %, +2.5 s after 4 min)
  input: {
    pacing: oneOf("INPUT_PACING", "absolute", ["absolute", "sleep"] as const),
    // Which live input runs: the SRT listener or the browser microphone page. Exactly one, never both.
    source: oneOf("INPUT_SOURCE", "srt", ["srt", "browser"] as const),
  },
  // Browser microphone input (INPUT_SOURCE=browser). Silence level and seconds are provisional
  // (to be set after the live measurement).
  ingest: {
    room: str("INGEST_ROOM", `${process.env.LIVEKIT_ROOM || "translation"}-ingest`),
    notAfterParam: str("INGEST_NOT_AFTER_PARAM", ""),
    sessionGraceSec: safeNum("INGEST_SESSION_GRACE_SEC", 60, 10, 600),
    silenceDb: safeNum("INGEST_SILENCE_DB", -60, -120, 0),
    silenceSec: safeNum("INGEST_SILENCE_SEC", 30, 5, 600),
    maxQueueMs: 500,
    levelLogSec: 5,
    notAfterPollSec: 60,
  },

  // Playback of synthesized chunks. Chunks play in order and are never cut mid-playback;
  // when the output falls behind the speaker, Polly speaks faster (speed: graded levels, or
  // speedupSteps with SPEED_MODE=steps), and
  // past maxBacklogMs whole queued chunks are dropped (0 = never drop).
  // backlogMs = how late a chunk's Japanese would start relative to its last English word.
  playback: {
    // Graduated speed-up "backlogMs:ratePercent,...": the highest step whose threshold
    // is exceeded applies (below the first step: 100%). "off" or "" disables.
    // Used only with SPEED_MODE=steps (the revert switch).
    speedupSteps: SPEEDUP_STEPS,
    // Graded speed levels (see speed-control.ts).
    speed: {
      mode: oneOf("SPEED_MODE", "levels", ["levels", "steps", "off"] as const),
      ...speedLevelMap(),
      hysteresisMs: safeNum("SPEED_HYSTERESIS_MS", 1500, 0, 10000),
      holdMs: safeNum("SPEED_HOLD_MS", 8000, 0, 60000),
      urgentMs: safeNum("SPEED_URGENT_MS", 10000, 0, 120000),
      lookahead: safeNum("SPEED_LOOKAHEAD", 1, 0, 2),
      msPerChar: safeNum("SPEED_MS_PER_CHAR", 165, 20, 1000),
      resetGapMs: safeNum("SPEED_RESET_GAP_MS", 3000, 0, 60000),
      steps: SPEEDUP_STEPS,
    },
    // Hard latency cap: before a chunk is synthesized, if its projected backlog exceeds
    // this, it is dropped (whole chunk, never mid-playback) as long as a newer chunk is
    // queued; the newest chunk is always kept. 0 disables (never drop).
    maxBacklogMs: safeNum("MAX_BACKLOG_MS", 10000),
    // Per-call timeout for Translate / Polly (ms).
    callTimeoutMs: safeNum("AWS_CALL_TIMEOUT_MS", 8000, 1000, 60000),
  },

  // Audio output. "livekit" (production) or "file" (local tests: raw s16le PCM file).
  sink: {
    kind: oneOf("AUDIO_SINK", "livekit", ["livekit", "file"] as const),
    outputFile: str("OUTPUT_FILE", "out.pcm"),
  },

  correction: {
    enabled: bool("ENABLE_CORRECTION", true),
  },

  // Filler removal so hesitations are never translated/spoken (see fillers.ts).
  fillers: {
    enabled: oneOf("FILLER_FILTER", "on", ["on", "off"] as const) === "on",
    // Always removed (whole words).
    words: list("FILLER_WORDS", "um,uh,er,ah,hmm,mm,erm,uh-huh"),
    // Removed only as discourse markers (chunk/sentence start + comma/nothing, or between commas).
    phrases: list("FILLER_PHRASES", "you know,I mean,well,like,sort of,kind of,you see,okay so,so yeah"),
    // Japanese safety net after Translate (start of text or after 。/、; "…、" = sentence start only).
    jaPatterns: list(
      "JA_FILLER_PATTERNS",
      "ええと,えーと,えっと,えー,あの,あのー,まあ,ご存知のとおり,ご存知のように,ご存じのとおり,ご存じのように,ほら,つまり、",
    ),
  },

  translate: {
    sourceLanguageCode: str("TRANSLATE_SOURCE", "en"),
    targetLanguageCode: str("TRANSLATE_TARGET", "ja"),
    terminologyName: str("TRANSLATE_TERMINOLOGY", ""),
    // Politeness of the Japanese output (Settings.Formality). off = revert switch (no Settings).
    formality: translateFormality(process.env),
    // translate = Amazon Translate (default). llm = Bedrock LLM with Translate as per-chunk fallback.
    engine: translateEngine(process.env),
  },

  llm: llmConfig(process.env),

  polly: {
    voiceId: str("POLLY_VOICE", "Kazuha"),
    engine: str("POLLY_ENGINE", "neural"),
    sampleRateHertz: num("POLLY_SAMPLE_RATE", 16000),
    // App-side pronunciation readings: known Latin terms are wrapped in SSML <sub alias=...> before
    // Polly (polly-readings.ts). off = revert switch (today's text, byte for byte).
    readings: pollyReadings(process.env),
    // Default: assets/polly-readings.csv in the app root (next to dist/ in the image; the Docker build copies it from the
    // dictionary folder). Local runs set POLLY_READINGS_FILE.
    readingsFile:
      str("POLLY_READINGS_FILE", "").trim() || fileURLToPath(new URL("../assets/polly-readings.csv", import.meta.url)),
  },

  // Live captions on the LiveKit data channel (caption-event.ts). off = no data packets at all.
  // japaneseSpeech: results the language gate classifies as Japanese are also shown, as said (never translated or spoken).
  captions: { enabled: captions(process.env) === "on", japaneseSpeech: captionsJapaneseSpeech(process.env) === "on" },

  livekit: {
    url: str("LIVEKIT_URL", "ws://127.0.0.1:7880"),
    apiKey: str("LIVEKIT_API_KEY", "devkey"),
    apiSecret: str("LIVEKIT_API_SECRET", "secret"), // secret; not committed
    roomName: str("LIVEKIT_ROOM", "translation"),
    tokenTtl: str("LIVEKIT_TOKEN_TTL", "4h"),
  },
} as const;
