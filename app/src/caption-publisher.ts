// CaptionPublisher: sends caption events (caption-event.ts) on the LiveKit data channel.
// Owns the single `seq` counter, the coalescing buffer for English source words, the counters
// for the [captions] log line, and the on/off switch (enabled=false makes every method a no-op:
// no packets, no timers, no events built).
//
// Sends never throw and never block the pipeline: a failing publishData is counted and logged
// (at most once per 30 s).

import {
  CAPTION_TOPIC,
  buildCaptionEvent,
  buildSourceAppend,
  buildSourceRetract,
  buildSpeechAppend,
  buildSpeechRetract,
  encodeCaptionEvent,
  type CaptionEvent,
} from "./caption-event.js";
import { log } from "./log.js";
import type { SegmenterTap } from "./segmenter.js";
import type { JapaneseSpeechTap } from "./language-gate.js";

export interface CaptionTransport {
  publishData?(payload: Uint8Array, topic: string): Promise<void>;
}

const SENTENCE_END = new Set([".", "?", "!"]);
export const SOURCE_FLUSH_MS = 250;
export const JA_HOLD_MAX_MS = 8000;
export const JA_CARRY_MS = 2000;

interface Buffered {
  kind: "source";
  session: number;
  resultId: string;
  text: string;
  boundary: boolean;
  audioEnd: number;
  lagBase: number; // wall ms of the end of the latest word (t0 + audioEnd)
}

export class CaptionPublisher {
  private seq = 0;
  private srcN = 0;
  private speechN = 0;
  private buf: Buffered | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly holds = new Set<() => void>(); // one per Japanese tap: publishes what it still holds
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  readonly stats = {
    caption: 0, source: 0, retracted: 0, failed: 0, lagSum: 0, lagMax: 0, lagN: 0,
    speech: 0, speechRetracted: 0, speechLagSum: 0, speechLagMax: 0, speechLagN: 0,
  };

  constructor(
    private readonly transport: CaptionTransport,
    readonly enabled: boolean,
    private readonly flushMs = SOURCE_FLUSH_MS,
    // CAPTIONS_JA_SPEECH: also publish Japanese speech as said (language-gate tap). false = no such events at all.
    readonly japaneseSpeech = true,
    // Longest a Japanese sentence is held for its end (counted from its first held word).
    private readonly jaHoldMs = JA_HOLD_MAX_MS,
    // How long the unfinished rest of a sentence waits after its result ended, for the next result to continue it.
    private readonly jaCarryMs = JA_CARRY_MS,
  ) {}

  // True when events will actually be published (enabled and the sink has a data channel).
  get active(): boolean {
    return this.enabled && typeof this.transport.publishData === "function";
  }

  // Japanese caption: called by the chunk player at the audio play-start moment.
  sendCaption(a: {
    session: number;
    chunkSeq: number;
    text: string;
    sourceText: string;
    startAt: number;
    durationMs: number;
  }): void {
    if (!this.active) return;
    this.send(buildCaptionEvent({ ...a, seq: ++this.seq }), "caption");
  }

  // Tap for one Segmenter. `t0()` = wall ms of Transcribe stream time 0 (for the lag figure only).
  // `isFiller` = extra single-word fillers to hide (config.fillers.words).
  tapFor(session: number, t0: () => number, isFiller: (word: string) => boolean = () => false): SegmenterTap | undefined {
    if (!this.active) return undefined;
    return {
      onWords: (b) => {
        let text = "";
        let boundary = false;
        let skipComma = false;
        for (const t of b.tokens) {
          if (t.punct) {
            if (skipComma && t.content === ",") continue;
            skipComma = false;
            text += t.content;
            if (SENTENCE_END.has(t.content)) boundary = true;
          } else if (t.filler || isFiller(t.content)) {
            skipComma = true;
          } else {
            skipComma = false;
            text += (text && !/^[.,?!;:]/.test(t.content) ? " " : "") + t.content;
          }
        }
        if (text === "") return;
        this.appendSource(session, b.resultId.slice(0, 8), text, boundary, b.audioEnd, t0() + b.audioEnd * 1000);
      },
      onRetract: (resultId) => this.retract(session, resultId.slice(0, 8)),
    };
  }

  // Tap for one LanguageGate: Japanese speech shown as said, one whole sentence per event. undefined (nothing to wire)
  // when captions are off, there is no data channel, or CAPTIONS_JA_SPEECH=off. Words are already stable and
  // filler-filtered. They are held until a sentence end (。？！?!), the end of their result, the end of the stream, or
  // jaHoldMs after the first held word; so a translation line that arrives in between cannot cut a sentence in two.
  japaneseTapFor(session: number, t0: () => number): JapaneseSpeechTap | undefined {
    if (!this.active || !this.japaneseSpeech) return undefined;
    interface Held { resultId: string; text: string; firstBase: number; lastEnd: number; timer: NodeJS.Timeout; ended: boolean; grace: NodeJS.Timeout | null }
    let held: Held | null = null;
    const published = new Set<string>(); // results with words on the wire (a retract is owed if they flip)
    const emit = (resultId: string, text: string, boundary: boolean, final: boolean, firstBase: number, lastEnd: number): void => {
      if (text === "") return;
      this.flush(); // English words buffered earlier go out first
      const now = Date.now();
      published.add(resultId);
      this.speechSentence(session, resultId, text, boundary, final, lastEnd, now - (t0() + lastEnd * 1000), now - firstBase);
    };
    const release = (final: boolean): void => {
      const h = held;
      if (!h) return;
      held = null;
      clearTimeout(h.timer);
      if (h.grace) clearTimeout(h.grace);
      emit(h.resultId, h.text, /[。？！?!]["')」』”]*$/.test(h.text), final, h.firstBase, h.lastEnd);
    };
    // The result ended without a sentence end: Transcribe often finalises a result in the middle of a sentence and the
    // next result continues it, so the rest is kept for jaCarryMs before it is published as it is.
    const endResult = (): void => {
      const h = held;
      if (!h || h.ended) return;
      h.ended = true;
      h.grace = setTimeout(() => release(true), this.jaCarryMs);
      h.grace.unref?.();
    };
    this.holds.add(() => release(false));
    return {
      onSpeech: (b) => {
        const id = b.resultId.slice(0, 8);
        if (held && held.resultId !== id) {
          if (!held.ended) release(false); // another result began while this one is still open: do not mix them
          else {
            // the next result continues the unfinished sentence of the one that just ended
            if (held.grace) clearTimeout(held.grace);
            held.grace = null;
            held.ended = false;
            held.resultId = id;
          }
        }
        let n = 0;
        for (const t of b.tokens) {
          n++;
          if (!held) {
            const start = typeof t.start === "number" ? t0() + t.start * 1000 : Date.now();
            const timer = setTimeout(() => release(false), this.jaHoldMs);
            timer.unref?.();
            held = { resultId: id, text: "", firstBase: start, lastEnd: b.audioEnd, timer, ended: false, grace: null };
          }
          held.text += t.content;
          if (typeof t.end === "number") held.lastEnd = t.end;
          if (t.punct && /[。？！?!]/.test(t.content)) {
            // the sentence is complete: publish it whole
            release(n === b.tokens.length && b.final);
          }
        }
        if (b.final) endResult();
      },
      onResultEnd: (resultId) => {
        if (held && held.resultId === resultId.slice(0, 8)) endResult();
        published.delete(resultId.slice(0, 8));
      },
      onStreamEnd: () => {
        release(false);
        published.clear();
      },
      onRetract: (resultId) => {
        const id = resultId.slice(0, 8);
        if (held && held.resultId === id) {
          clearTimeout(held.timer);
          if (held.grace) clearTimeout(held.grace);
          held = null; // never published: simply dropped
        }
        if (!published.delete(id)) return;
        this.flush();
        this.stats.speechRetracted++;
        this.send(buildSpeechRetract({ session, seq: ++this.seq, resultId: id }), "speech");
      },
    };
  }
  private speechSentence(session: number, resultId: string, text: string, boundary: boolean, final: boolean, audioEnd: number, lagLast: number, lagFirst: number): void {
    const seq = ++this.seq;
    this.stats.speechLagSum += lagLast;
    this.stats.speechLagN++;
    this.stats.speechLagMax = Math.max(this.stats.speechLagMax, lagLast);
    log.debug(`[speech] seq=${seq} resultId=${resultId} audioEnd=${audioEnd.toFixed(2)} lagLastMs=${Math.round(lagLast)} lagFirstMs=${Math.round(lagFirst)} final=${final} text="${text}"`);
    this.send(buildSpeechAppend({ session, n: ++this.speechN, seq, resultId, text, boundary, final, audioEnd }), "speech");
  }
  private appendSource(session: number, resultId: string, text: string, boundary: boolean, audioEnd: number, lagBase: number): void {
    this.appendBuffered("source", session, resultId, text, boundary, audioEnd, lagBase);
  }
  private appendBuffered(
    kind: "source",
    session: number,
    resultId: string,
    text: string,
    boundary: boolean,
    audioEnd: number,
    lagBase: number,
  ): void {
    const cur = this.buf;
    if (cur && (cur.kind !== kind || cur.session !== session || cur.resultId !== resultId)) this.flush();
    if (this.buf) {
      const b = this.buf;
      b.text += (/^[.,?!;:]/.test(text) ? "" : " ") + text;
      b.boundary = b.boundary || boundary; // any sentence end in the batch
      b.audioEnd = audioEnd;
      b.lagBase = lagBase;
    } else {
      this.buf = { kind, session, resultId, text, boundary, audioEnd, lagBase };
    }
    if (boundary) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  private retract(session: number, resultId: string): void {
    // Words of that result still buffered would be sent just before the retract; flush keeps order.
    this.flush();
    this.stats.retracted++;
    this.send(buildSourceRetract({ session, seq: ++this.seq, resultId }), "source");
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const b = this.buf;
    if (!b) return;
    this.buf = null;
    const seq = ++this.seq;
    const lag = Date.now() - b.lagBase;
    this.stats.lagSum += lag;
    this.stats.lagN++;
    this.stats.lagMax = Math.max(this.stats.lagMax, lag);
    log.debug(`[source] seq=${seq} resultId=${b.resultId} audioEnd=${b.audioEnd.toFixed(2)} lagMs=${Math.round(lag)} text="${b.text}"`);
    this.send(
      buildSourceAppend({
        session: b.session,
        n: ++this.srcN,
        seq,
        resultId: b.resultId,
        text: b.text,
        boundary: b.boundary,
        audioEnd: b.audioEnd,
      }),
      "source",
    );
  }
  // Flush and stop timers (shutdown).
  close(): void {
    for (const release of this.holds) release();
    this.flush();
  }

  private send(ev: CaptionEvent, kind: "caption" | "source" | "speech"): void {
    let p: Promise<void>;
    try {
      p = Promise.resolve(this.transport.publishData!(encodeCaptionEvent(ev), CAPTION_TOPIC));
    } catch (err) {
      this.fail(err);
      return;
    }
    p.then(
      () => {
        this.stats[kind]++;
      },
      (err) => this.fail(err),
    );
  }

  private fail(err: unknown): void {
    this.stats.failed++;
    const now = Date.now();
    if (now - this.lastWarnAt >= 30_000) {
      this.lastWarnAt = now;
      log.warn(`[captions] publishData failed (further failures counted, logged every 30 s): ${String(err)}`);
    }
  }

  startupLine(): string {
    return `  captions=${this.enabled ? "on" : "off"} topic=${CAPTION_TOPIC} schema=1 sourceLine=default-on` +
      (this.enabled ? ` jaSpeech=${this.japaneseSpeech ? "on" : "off"}` : "") +
      (this.enabled && !this.active ? " (sink has no data channel: nothing is sent)" : "");
  }

  summaryLine(label: string): string | null {
    if (!this.enabled) return null;
    const s = this.stats;
    const avg = s.lagN ? Math.round(s.lagSum / s.lagN) : 0;
    return (
      `[captions] ${label} caption=${s.caption} source=${s.source} retracted=${s.retracted} failed=${s.failed} ` +
      `sourceLagMs(avg/max)=${avg}/${Math.round(s.lagMax)}` +
      (this.japaneseSpeech
        ? ` speech=${s.speech} speechRetracted=${s.speechRetracted} speechLagMs(avg/max)=${s.speechLagN ? Math.round(s.speechLagSum / s.speechLagN) : 0}/${Math.round(s.speechLagMax)}`
        : "")
    );
  }
}
