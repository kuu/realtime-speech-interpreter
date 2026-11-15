// Polly speaking-speed control (pure, no AWS imports, unit-tested in speed-control.test.ts).
//
// SPEED_MODE:
//   levels (default) = graded levels L1..Ln (SPEED_LEVELS, percent) chosen from the projected
//                      backlog plus a look-ahead of this chunk's length, with hysteresis, a slew
//                      limit of +-1 level per chunk and a hold time, so the speed ramps instead of
//                      jumping between "slow" and "fast"
//   steps            = revert switch: exactly the old SPEEDUP_STEPS mapping (rate per chunk from
//                      the instantaneous backlog)
//   off              = always 100% (plain text)
// The rate is chosen right before the Polly call, so none of this adds processing delay.

import type { SpeedupStep } from "./config.js";
import { escapeXml } from "./xml.js";
import type { Readings } from "./polly-readings.js";

export { escapeXml };
// SSML for a prosody rate, or null for 100% (synthesize as plain text). Polly accepts
// 20-200%; we only ever speed up, so 100-200 integers are allowed.
export function buildSsml(text: string, rate: number): string | null {
  return buildSsmlWithReadings(text, rate, null).ssml;
}
// Same, with pronunciation readings (polly-readings.ts) applied to the text. Rate 100 and no
// hit = null (plain text, unchanged path); hits at 100 = <speak>...</speak>; other rates add prosody.
export function buildSsmlWithReadings(
  text: string,
  rate: number,
  readings: Readings | null,
): { ssml: string | null; hits: number } {
  if (!Number.isInteger(rate) || rate < 100 || rate > 200) {
    throw new Error(`invalid prosody rate ${rate} (integer 100-200 required)`);
  }
  const { inner, hits } = readings ? readings.apply(text) : { inner: escapeXml(text), hits: 0 };
  if (rate === 100) return { ssml: hits === 0 ? null : `<speak>${inner}</speak>`, hits };
  return { ssml: `<speak><prosody rate="${rate}%">${inner}</prosody></speak>`, hits };
}
// SSML when needed, with a plain-text retry if Polly rejects the SSML (so a bad SSML still speaks).
// once(text, isSsml) performs the Polly call. Returns the rate/hits actually used.
export async function synthesizeWithFallback<T>(
  text: string,
  rate: number,
  readings: Readings | null,
  once: (payload: string, ssml: boolean) => Promise<T>,
  onSsmlFailure: (err: unknown) => void,
): Promise<{ pcm: T; rate: number; hits: number }> {
  const { ssml, hits } = buildSsmlWithReadings(text, rate, readings);
  if (ssml !== null) {
    try {
      return { pcm: await once(ssml, true), rate, hits };
    } catch (err) {
      onSsmlFailure(err);
    }
  }
  return { pcm: await once(text, false), rate: 100, hits: 0 };
}
// Old rateFor(): highest step whose threshold the backlog exceeds; 100% below the first step.
// level = 1 + number of steps applied (steps are sorted ascending by the parser).
export function stepsRate(steps: readonly SpeedupStep[], backlogMs: number): { rate: number; level: number } {
  let rate = 100;
  let level = 1;
  for (const step of steps) {
    if (backlogMs >= step.backlogMs) {
      rate = step.rate;
      level++;
    }
  }
  return { rate, level };
}

// Characters Polly actually speaks (no whitespace, punctuation or symbols).
export function spokenChars(ja: string): number {
  let n = 0;
  for (const ch of ja) {
    if (!/[\s\p{P}\p{S}]/u.test(ch)) n++;
  }
  return n;
}

export type SpeedMode = "levels" | "steps" | "off";
export type SpeedWhy = "target" | "slew" | "hold" | "hyst" | "urgent" | "reset" | "steps" | "off";

export interface SpeedConfig {
  mode: SpeedMode;
  levels: readonly number[]; // percent per level, ascending, levels[0] is L1
  thresholdsMs: readonly number[]; // signal needed to ENTER L2..Ln (levels.length - 1 values)
  hysteresisMs: number; // going down from Li needs signal < threshold(Li) - hysteresisMs
  holdMs: number; // audio ms that must play at the current level before the next change
  urgentMs: number; // signal >= this: jump straight up to the target (0 = never)
  lookahead: number; // weight of max(0, estJaMs - enSpanMs) in the signal (0 = off)
  msPerChar: number; // estimated ms of Japanese audio per spoken char at L1
  resetGapMs: number; // output idle >= this before the chunk: step down straight to the target (0 = never)
  steps: readonly SpeedupStep[]; // used only in steps mode
}

export interface SpeedInput {
  backlogMs: number; // projected backlog at synth time (same value dropForBacklog uses)
  estJaMs: number; // estimated Japanese audio at L1
  enSpanMs: number; // duration of the English chunk
  idleGapMs: number; // how long the output would have been silent before this chunk starts
}

export interface SpeedDecision {
  level: number; // 1-based
  rate: number; // percent
  targetLevel: number; // 1-based level the signal alone asks for
  signalMs: number;
  why: SpeedWhy;
}

export class SpeedController {
  private cur = 0; // 0-based current level
  private msAtLevel = Number.POSITIVE_INFINITY; // first chunk: hold already satisfied

  constructor(private readonly cfg: SpeedConfig) {}

  decide(input: SpeedInput): SpeedDecision {
    const cfg = this.cfg;
    if (cfg.mode === "off") {
      return { level: 1, rate: 100, targetLevel: 1, signalMs: input.backlogMs, why: "off" };
    }
    if (cfg.mode === "steps") {
      const s = stepsRate(cfg.steps, input.backlogMs);
      return { level: s.level, rate: s.rate, targetLevel: s.level, signalMs: input.backlogMs, why: "steps" };
    }

    const T = cfg.thresholdsMs;
    const n = cfg.levels.length;
    const cur = this.cur;
    const signal = input.backlogMs + cfg.lookahead * Math.max(0, input.estJaMs - input.enSpanMs);

    // Raw target: up with the plain thresholds, down only past the hysteresis band.
    let t = cur;
    while (t + 1 < n && signal >= T[t]) t++;
    let hystBlocked = false;
    if (t === cur) {
      while (t > 0 && signal < T[t - 1] - cfg.hysteresisMs) t--;
      if (t > 0 && signal < T[t - 1]) hystBlocked = true; // below the threshold but inside the band
    }

    const holding = this.msAtLevel < cfg.holdMs;
    let next = cur;
    let why: SpeedWhy;
    if (t > cur) {
      if (cfg.urgentMs > 0 && signal >= cfg.urgentMs) {
        next = t;
        why = "urgent";
      } else if (holding) {
        why = "hold";
      } else {
        next = cur + 1;
        why = next === t ? "target" : "slew";
      }
    } else if (t < cur) {
      if (cfg.resetGapMs > 0 && input.idleGapMs >= cfg.resetGapMs) {
        next = t;
        why = "reset";
      } else if (holding) {
        why = "hold";
      } else {
        next = cur - 1;
        why = next === t ? "target" : "slew";
      }
    } else {
      why = hystBlocked ? "hyst" : "target";
    }

    if (next !== cur) {
      this.cur = next;
      this.msAtLevel = 0;
    }
    return { level: next + 1, rate: cfg.levels[next], targetLevel: t + 1, signalMs: signal, why };
  }

  // Japanese audio actually synthesized at the current level (feeds the hold).
  recordAudio(audioMs: number): void {
    if (audioMs > 0) this.msAtLevel += audioMs;
  }
}
