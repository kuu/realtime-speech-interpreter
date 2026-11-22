// Translation engines. TRANSLATE_ENGINE=translate (default) calls Amazon Translate exactly as before.
// TRANSLATE_ENGINE=llm calls a Bedrock LLM per chunk and falls back to Translate for that chunk on any
// problem (timeout, throttle, access, network, rejected output, open circuit breaker, no glossary).
// The only error that escapes translate() is a Translate failure (same as the old code path).
import { config, type LlmConfig, type TranslateEngineName } from "./config.js";
import { log as realLog } from "./log.js";
import { loadDeployedGlossary, glossaryLines, type FetchFn, type GlossaryDirection, type GlossaryEntry } from "./glossary.js";
import { buildSystemText, buildConverseRequest, chunkEndsSentence, type PreviousItem } from "./llm-prompt.js";
import { buildSystemTextJaEn, buildConverseRequestJaEn, chunkEndsSentenceJa } from "./llm-prompt-ja-en.js";
import { validateLlmOutput, validateLlmOutputEn, missingNames } from "./llm-validate.js";
import { CircuitBreaker, classifyError, LlmTimeoutError, type BreakerState } from "./llm-breaker.js";
import { LlmStats, type LlmUsage } from "./llm-stats.js";
import type { LlmClient } from "./bedrock-llm.js";
import { translateText, translateTextFor, translateClient } from "./translate-call.js";
import type { LaneSettings } from "./lane-settings.js";

export interface EngineRequest {
  text: string; // the chunk's source text (English; Japanese for a ja-en lane), after filler filter and corrections
  previous: readonly PreviousItem[];
  forceTranslate?: boolean; // skip-backlog: use Translate for this chunk
}

export interface EngineResult {
  text: string; // the translation (Japanese; English for a ja-en lane), trimmed (may be empty only on the Translate path, as before)
  engine: "translate" | "llm" | "fallback";
  fallbackReason?: string;
  llmMs?: number; // duration of the LLM call (also for failed/timed-out calls); absent if none was made
  usage?: LlmUsage;
  detail?: string; // short failure detail for the log
  rejected?: { rule: string; ja: string }; // output validation rejection
}

export interface TranslationEngine {
  readonly name: TranslateEngineName;
  readonly contextChunks: number; // 0 = the engine does not use context
  readonly contextResetMs: number;
  readonly skipBacklogMs: number; // 0 = off
  translate(req: EngineRequest): Promise<EngineResult>;
  summaryLine(label: string): string | null;
  startupLine(): string | null;
  dispose(): void;
}

type TranslateFn = (text: string) => Promise<string>;
interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

// The old code path: one Translate call, result trimmed.
export class TranslateOnlyEngine implements TranslationEngine {
  readonly name = "translate" as const;
  readonly contextChunks = 0;
  readonly contextResetMs = 0;
  readonly skipBacklogMs = 0;
  constructor(private readonly translateFn: TranslateFn = translateText) {}
  async translate(req: EngineRequest): Promise<EngineResult> {
    return { text: (await this.translateFn(req.text)).trim(), engine: "translate" };
  }
  summaryLine(): string | null {
    return null;
  }
  startupLine(): string | null {
    return null;
  }
  dispose(): void {}
}

export interface LlmEngineDeps {
  cfg: LlmConfig;
  llm: LlmClient;
  translate: TranslateFn;
  // null = glossary could not be loaded: every chunk uses Translate (glossary-unavailable).
  glossary: readonly GlossaryEntry[] | null;
  // en-ja (default) = today's English-to-Japanese lane; ja-en = Japanese to English (own prompt, validator, name check).
  direction?: GlossaryDirection;
  now?: () => number;
  log?: Logger;
  warmTimeoutMs?: number;
}

const OK_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);
const WARM_CHUNK = "Hello everyone.";
const WARM_CHUNK_JA = "皆さん、こんにちは。";

function q(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
}
function shortErr(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const s = e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}` : String(err);
  return s.replace(/\s+/g, " ").slice(0, 120);
}

export class LlmEngine implements TranslationEngine {
  readonly name = "llm" as const;
  readonly stats: LlmStats;
  readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly systemText: string;
  private readonly glossary: readonly GlossaryEntry[];
  private readonly dir: GlossaryDirection;
  private readonly cache: boolean;
  private lastCallAt: number;
  private inFlight = 0;
  private keepWarmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: LlmEngineDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? realLog;
    this.glossary = d.glossary ?? [];
    this.dir = d.direction ?? "en-ja";
    this.cache = d.cfg.glossary === "full"; // Haiku 4.5 needs >= 4096 prefix tokens, only the full glossary reaches that
    const lines = d.cfg.glossary === "full" ? glossaryLines(this.glossary) : "";
    this.systemText = this.dir === "ja-en" ? buildSystemTextJaEn(lines) : buildSystemText(lines, d.cfg.promptVersion);
    this.stats = new LlmStats(this.cache);
    this.lastCallAt = this.now();
    this.breaker = new CircuitBreaker({
      openMs: d.cfg.breakerMs,
      now: this.now,
      onTransition: (to: BreakerState, reason: string, forMs: number) => {
        if (to === "open") {
          this.stats.recordBreakerOpened();
          this.log.warn(`[llm] BREAKER open reason=${q(reason)} forMs=${forMs}`);
        } else {
          this.log.info(`[llm] BREAKER ${to} reason=${q(reason)} forMs=${forMs}`);
        }
      },
    });
  }

  get contextChunks(): number {
    return this.d.cfg.contextChunks;
  }
  get contextResetMs(): number {
    return this.d.cfg.contextResetMs;
  }
  get skipBacklogMs(): number {
    return this.d.cfg.skipBacklogMs;
  }
  get glossaryAvailable(): boolean {
    return this.d.glossary !== null;
  }

  startupLine(): string {
    const c = this.d.cfg;
    const gl = this.d.glossary === null ? "unavailable" : c.glossary === "full" ? `full(${this.glossary.length})` : "off";
    return (
      `  llm engine=llm model=${c.modelId} timeoutMs=${c.timeoutMs} contextChunks=${c.contextChunks} glossary=${gl} ` +
      `maxTokens=${c.maxTokens} breakerMs=${c.breakerMs} skipBacklogMs=${c.skipBacklogMs} ` +
      `parallelFallback=${c.parallelFallback ? "on" : "off"} contextResetMs=${c.contextResetMs} ` +
      `maxCharsPerWord=${c.maxCharsPerWord} keepWarmMs=${c.keepWarmMs} promptVersion=${c.promptVersion}`
    );
  }

  summaryLine(label: string): string {
    return this.stats.summaryLine(label);
  }

  dispose(): void {
    if (this.keepWarmTimer) clearInterval(this.keepWarmTimer);
    this.keepWarmTimer = null;
  }

  async translate(req: EngineRequest): Promise<EngineResult> {
    if (this.d.glossary === null) return this.fallback(req, "glossary-unavailable");
    if (req.forceTranslate) return this.fallback(req, "skip-backlog");
    if (!this.breaker.allow()) return this.fallback(req, "breaker-open");

    // Parallel fallback: Translate starts now and is used if the LLM fails or is late.
    let parallel: Promise<string> | null = null;
    if (this.d.cfg.parallelFallback) {
      this.stats.recordTranslateCall();
      parallel = this.d.translate(req.text);
      parallel.catch(() => {}); // a discarded/failed parallel result must never be an unhandled rejection
    }

    const request =
      this.dir === "ja-en"
        ? buildConverseRequestJaEn({
            modelId: this.d.cfg.modelId,
            system: this.systemText,
            previous: req.previous,
            chunk: req.text,
            maxTokens: this.d.cfg.maxTokens,
            cache: this.cache,
            endsSentence: chunkEndsSentenceJa(req.text),
          })
        : buildConverseRequest({
            modelId: this.d.cfg.modelId,
            system: this.systemText,
            previous: req.previous,
            chunk: req.text,
            maxTokens: this.d.cfg.maxTokens,
            cache: this.cache,
            endsSentence: this.d.cfg.promptVersion === 2 ? chunkEndsSentence(req.text) : undefined,
          });
    const t0 = this.now();
    let res;
    try {
      res = await this.callWithTimeout(request, this.d.cfg.timeoutMs);
    } catch (err) {
      const llmMs = this.now() - t0;
      const c = classifyError(err);
      this.stats.recordCall({ ms: llmMs });
      this.breaker.onFailure(c.kind, c.reason);
      return this.fallback(req, c.reason, { llmMs, detail: shortErr(err), parallel });
    }
    const llmMs = this.now() - t0;
    this.lastCallAt = this.now();
    this.stats.recordCall({ ms: llmMs, usage: res.usage });
    const warn = this.stats.cacheWarning(this.now());
    if (warn) this.log.warn(warn);

    let reason: string | null = null;
    let detail = "";
    let rule = "";
    let validated = "";
    if (res.stopReason === "max_tokens") {
      reason = "truncated";
      rule = "truncated";
      detail = "stopReason=max_tokens";
    } else if (!OK_STOP_REASONS.has(res.stopReason)) {
      reason = "validation-stop-reason";
      rule = "stop-reason";
      detail = `stopReason=${res.stopReason || "none"}`;
    } else {
      const v =
        this.dir === "ja-en"
          ? validateLlmOutputEn(res.text, { source: req.text, glossary: this.glossary, maxWordsPerChar: 1.2 })
          : validateLlmOutput(res.text, { source: req.text, glossary: this.glossary, maxCharsPerWord: this.d.cfg.maxCharsPerWord });
      if (v.ok) validated = v.text;
      else {
        rule = v.rule;
        detail = v.detail;
        reason = v.rule === "empty" ? "empty" : `validation-${v.rule}`;
      }
    }
    if (reason !== null) {
      this.breaker.onFailure("content", reason);
      return this.fallback(req, reason, {
        llmMs,
        usage: res.usage,
        detail,
        parallel,
        rejected: { rule, ja: res.text.replace(/\s+/g, " ").slice(0, 120) },
      });
    }
    // ja-en name check: a glossary name present in the source must appear in the output, else Translate does this chunk.
    if (this.dir === "ja-en") {
      const miss = missingNames(req.text, validated, this.glossary);
      if (miss.length > 0) {
        this.breaker.onSuccess(); // the model answered; only the names are wrong, so the breaker is not tripped
        const r = await this.fallback(req, "name-miss", { llmMs, usage: res.usage, detail: `missing=${miss.join("|")}`, parallel });
        const still = missingNames(req.text, r.text, this.glossary);
        if (still.length > 0) this.log.warn(`[llm] name-miss after fallback missing=${q(still.join("|"))} (output used as is)`);
        return r;
      }
    }
    this.breaker.onSuccess();
    this.stats.recordUsed();
    return { text: validated.trim(), engine: "llm", llmMs, usage: res.usage };
  }

  private async fallback(
    req: EngineRequest,
    reason: string,
    o: { llmMs?: number; usage?: LlmUsage; detail?: string; parallel?: Promise<string> | null; rejected?: EngineResult["rejected"] } = {},
  ): Promise<EngineResult> {
    this.stats.recordFallback(reason);
    let ja: string;
    if (o.parallel) ja = await o.parallel;
    else {
      this.stats.recordTranslateCall();
      ja = await this.d.translate(req.text);
    }
    return {
      text: ja.trim(),
      engine: "fallback",
      fallbackReason: reason,
      llmMs: o.llmMs,
      usage: o.usage,
      detail: o.detail,
      rejected: o.rejected,
    };
  }

  // Abort signal for the SDK plus a race, so a hung socket can never hold the worker past the timeout.
  private async callWithTimeout(request: ReturnType<typeof buildConverseRequest>, timeoutMs: number) {
    this.inFlight++;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new LlmTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    const call = this.d.llm.converse(request, ac.signal);
    call.catch(() => {}); // the loser of the race must not become an unhandled rejection
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
      this.inFlight--;
    }
  }

  // One dummy call: opens the TLS connection and creates the prompt cache. Never throws.
  async warmUp(kind: "warm-up" | "keep-warm" = "warm-up"): Promise<void> {
    if (this.d.glossary === null) return;
    const timeoutMs = this.d.warmTimeoutMs ?? 8000;
    const request =
      this.dir === "ja-en"
        ? buildConverseRequestJaEn({ modelId: this.d.cfg.modelId, system: this.systemText, previous: [], chunk: WARM_CHUNK_JA, maxTokens: 48, cache: this.cache, endsSentence: true })
        : buildConverseRequest({
            modelId: this.d.cfg.modelId,
            system: this.systemText,
            previous: [],
            chunk: WARM_CHUNK,
            maxTokens: 48,
            cache: this.cache,
            endsSentence: this.d.cfg.promptVersion === 2 ? true : undefined,
          });
    const t0 = this.now();
    try {
      const res = await this.callWithTimeout(request, timeoutMs);
      const ms = this.now() - t0;
      this.lastCallAt = this.now();
      this.stats.recordCall({ ms, usage: res.usage, warm: true });
      this.log.info(
        `[llm] ${kind} ok ms=${ms} inTok=${res.usage.inputTokens} outTok=${res.usage.outputTokens} ` +
          `cacheRead=${res.usage.cacheReadInputTokens} cacheWrite=${res.usage.cacheWriteInputTokens}`,
      );
    } catch (err) {
      const c = classifyError(err);
      this.stats.recordCall({ ms: this.now() - t0, warm: true });
      this.breaker.onFailure(c.kind, c.reason);
      this.log.warn(`[llm] ${kind} failed reason=${c.reason} detail=${q(shortErr(err))}`);
    }
  }

  // Sends a dummy call when the prompt cache is about to expire (5 min TTL) and the breaker is closed.
  async keepWarmTick(): Promise<boolean> {
    const every = this.d.cfg.keepWarmMs;
    if (every <= 0 || this.d.glossary === null || !this.cache) return false;
    if (this.breaker.state !== "closed" || this.inFlight > 0) return false;
    if (this.now() - this.lastCallAt < every) return false;
    await this.warmUp("keep-warm");
    return true;
  }

  startKeepWarm(periodMs = 60000): void {
    if (this.d.cfg.keepWarmMs <= 0 || this.keepWarmTimer) return;
    this.keepWarmTimer = setInterval(() => void this.keepWarmTick().catch(() => {}), periodMs);
    this.keepWarmTimer.unref();
  }
}

export interface FactoryDeps {
  // A lane (two-lane deploy or a non-default single lane): its engine, terminology, languages and direction. Absent =
  // lane 1 of today: the global config.
  lane?: LaneSettings;
  direction?: GlossaryDirection;
  engine: TranslateEngineName;
  cfg: LlmConfig;
  translate: TranslateFn;
  makeLlm: () => Promise<LlmClient> | LlmClient;
  loadGlossary: () => Promise<GlossaryEntry[]>;
  now?: () => number;
  log?: Logger;
}

export function directionOf(lane: Pick<LaneSettings, "source" | "target">): GlossaryDirection {
  return /^ja(-|$)/i.test(lane.source) && lane.target === "en" ? "ja-en" : "en-ja";
}

function defaultFactoryDeps(lane?: LaneSettings): FactoryDeps {
  if (lane) {
    const direction = directionOf(lane);
    return {
      lane,
      direction,
      engine: lane.translate.engine,
      cfg: config.llm,
      translate: translateTextFor(lane.translate),
      makeLlm: async () => (await import("./bedrock-llm.js")).createBedrockLlm(config.region),
      loadGlossary: () =>
        loadDeployedGlossary(translateClient, lane.translate.terminologyName, fetch as unknown as FetchFn, 10000, direction),
    };
  }
  return {
    engine: config.translate.engine,
    cfg: config.llm,
    translate: translateText,
    // Dynamic import: the Bedrock SDK is not even loaded unless the llm engine is selected.
    makeLlm: async () => (await import("./bedrock-llm.js")).createBedrockLlm(config.region),
    loadGlossary: () =>
      loadDeployedGlossary(translateClient, config.translate.terminologyName, fetch as unknown as FetchFn, 10000),
  };
}

// Never throws. Any init problem yields the Translate-only engine (or an llm engine that sends every
// chunk to Translate with glossary-unavailable) plus a loud ERROR line.
export async function createTranslationEngine(over: Partial<FactoryDeps> = {}): Promise<TranslationEngine> {
  const d = { ...defaultFactoryDeps(over.lane), ...over };
  const log = d.log ?? realLog;
  if (d.engine !== "llm") return new TranslateOnlyEngine(d.translate);
  try {
    let glossary: GlossaryEntry[] | null = [];
    if (d.cfg.glossary === "full") {
      try {
        glossary = await d.loadGlossary();
      } catch (err) {
        glossary = null;
        log.error(
          `LLM ENGINE DISABLED: glossary unavailable (${shortErr(err)}); every chunk will use Amazon Translate ` +
            `(fallbackReason=glossary-unavailable). Fix TRANSLATE_TERMINOLOGY / translate:GetTerminology and restart.`,
        );
      }
    }
    const llm = glossary === null ? ({ converse: async () => Promise.reject(new Error("llm disabled")) } as LlmClient) : await d.makeLlm();
    const engine = new LlmEngine({ cfg: d.cfg, llm, translate: d.translate, glossary, direction: d.direction, now: d.now, log: d.log });
    if (glossary !== null) {
      await engine.warmUp();
      engine.startKeepWarm();
    }
    return engine;
  } catch (err) {
    log.error(`LLM ENGINE DISABLED: init failed (${shortErr(err)}); using Amazon Translate only`);
    return new TranslateOnlyEngine(d.translate);
  }
}
