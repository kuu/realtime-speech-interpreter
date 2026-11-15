// Counters and cost estimate for the LLM engine. Pure.

export interface LlmUsage {
  inputTokens: number; // Converse reports these WITHOUT the cache read/write tokens
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}
export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };

// Claude Haiku 4.5 list prices, USD per 1M tokens (the jp. profile premium of ~10% is not included).
export const PRICE_PER_M = { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 } as const;

export function estimateUsd(u: LlmUsage): number {
  return (
    (u.inputTokens * PRICE_PER_M.input +
      u.outputTokens * PRICE_PER_M.output +
      u.cacheReadInputTokens * PRICE_PER_M.cacheRead +
      u.cacheWriteInputTokens * PRICE_PER_M.cacheWrite) /
    1e6
  );
}

// Nearest-rank percentile of an ascending-sorted or unsorted list; 0 for an empty list.
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

const WINDOW = 20;
const MIN_WINDOW_FOR_WARNING = 10;
const WARN_EVERY_MS = 60000;
const LOW_RATE = 0.8;

export class LlmStats {
  used = 0;
  fallback = 0;
  skipBacklog = 0;
  breakerOpened = 0;
  translateCalls = 0;
  readonly byReason: Record<string, number> = {};
  readonly tokens: LlmUsage = { ...ZERO_USAGE };
  private llmMs: number[] = [];
  private callsWithUsage = 0;
  private hits = 0;
  private recent: boolean[] = [];
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cacheExpected: boolean) {}

  // Every Bedrock call. `warm` = dummy warm-up / keep-warm call: tokens are counted, per-chunk
  // statistics are not.
  recordCall(o: { ms: number; usage?: LlmUsage; warm?: boolean }): void {
    if (o.usage) {
      this.tokens.inputTokens += o.usage.inputTokens;
      this.tokens.outputTokens += o.usage.outputTokens;
      this.tokens.cacheReadInputTokens += o.usage.cacheReadInputTokens;
      this.tokens.cacheWriteInputTokens += o.usage.cacheWriteInputTokens;
    }
    if (o.warm) return;
    this.llmMs.push(o.ms);
    if (o.usage) {
      const hit = o.usage.cacheReadInputTokens > 0;
      this.callsWithUsage++;
      if (hit) this.hits++;
      this.recent.push(hit);
      if (this.recent.length > WINDOW) this.recent.shift();
    }
  }
  recordUsed(): void {
    this.used++;
  }
  recordFallback(reason: string): void {
    if (reason === "skip-backlog") {
      this.skipBacklog++;
      return;
    }
    this.fallback++;
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1;
  }
  recordTranslateCall(): void {
    this.translateCalls++;
  }
  recordBreakerOpened(): void {
    this.breakerOpened++;
  }

  cacheHitRate(): number {
    return this.callsWithUsage === 0 ? 0 : this.hits / this.callsWithUsage;
  }
  estUsd(): number {
    return estimateUsd(this.tokens);
  }

  // Returns the WARN text when the rolling hit rate is low (at most once per 60 s), else null.
  cacheWarning(nowMs: number): string | null {
    if (!this.cacheExpected || this.recent.length < MIN_WINDOW_FOR_WARNING) return null;
    const rate = this.recent.filter(Boolean).length / this.recent.length;
    if (rate >= LOW_RATE || nowMs - this.lastWarnAt < WARN_EVERY_MS) return null;
    this.lastWarnAt = nowMs;
    return (
      `[llm] cache hit rate low rate=${rate.toFixed(2)} window=${this.recent.length} ` +
      `inTok=${this.tokens.inputTokens} cacheRead=${this.tokens.cacheReadInputTokens}`
    );
  }

  summaryLine(label: string): string {
    const reasons =
      Object.entries(this.byReason)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([r, n]) => `${r}:${n}`)
        .join(",") || "-";
    const n = this.llmMs.length;
    const mean = n ? Math.round(this.llmMs.reduce((a, b) => a + b, 0) / n) : 0;
    const t = this.tokens;
    return (
      `[llm-summary] ${label} engine=llm used=${this.used} fallback=${this.fallback} byReason=${reasons} ` +
      `skipBacklog=${this.skipBacklog} breakerOpened=${this.breakerOpened} meanLlmMs=${mean} ` +
      `p90LlmMs=${Math.round(percentile(this.llmMs, 90))} maxLlmMs=${Math.round(n ? Math.max(...this.llmMs) : 0)} ` +
      `cacheHitRate=${this.cacheHitRate().toFixed(2)} inTok=${t.inputTokens} outTok=${t.outputTokens} ` +
      `cacheRead=${t.cacheReadInputTokens} cacheWrite=${t.cacheWriteInputTokens} translateCalls=${this.translateCalls} ` +
      `estUsd=${this.estUsd().toFixed(4)}`
    );
  }
}
