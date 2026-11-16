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

interface Buffered {
  kind: "source" | "speech"; // English source words | Japanese speech as said
  final: boolean; // speech: the batch ends its result
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

  // Tap for one LanguageGate: Japanese speech shown as said. undefined (nothing to wire) when captions are off,
  // there is no data channel, or CAPTIONS_JA_SPEECH=off. Words are already stable and filler-filtered.
  japaneseTapFor(session: number, t0: () => number): JapaneseSpeechTap | undefined {
    if (!this.active || !this.japaneseSpeech) return undefined;
    return {
      onSpeech: (b) => {
        let text = "";
        let boundary = false;
        for (const t of b.tokens) {
          text += t.content;
          if (t.punct) boundary = /[。？！?!]/.test(t.content);
          else boundary = false;
        }
        if (text === "") return;
        this.appendBuffered("speech", session, b.resultId.slice(0, 8), text, boundary, b.audioEnd, t0() + b.audioEnd * 1000, b.final);
      },
      onRetract: (resultId) => {
        this.flush();
        this.stats.speechRetracted++;
        this.send(buildSpeechRetract({ session, seq: ++this.seq, resultId: resultId.slice(0, 8) }), "speech");
      },
    };
  }
  private appendSource(session: number, resultId: string, text: string, boundary: boolean, audioEnd: number, lagBase: number): void {
    this.appendBuffered("source", session, resultId, text, boundary, audioEnd, lagBase, false);
  }
  private appendBuffered(
    kind: "source" | "speech",
    session: number,
    resultId: string,
    text: string,
    boundary: boolean,
    audioEnd: number,
    lagBase: number,
    final: boolean,
  ): void {
    const cur = this.buf;
    if (cur && (cur.kind !== kind || cur.session !== session || cur.resultId !== resultId)) this.flush();
    if (this.buf) {
      const b = this.buf;
      b.text += (kind === "speech" || /^[.,?!;:]/.test(text) ? "" : " ") + text;
      // source: any sentence end in the batch; speech: the batch's last token decides (it closes the line)
      b.boundary = kind === "speech" ? boundary : b.boundary || boundary;
      b.final = b.final || final;
      b.audioEnd = audioEnd;
      b.lagBase = lagBase;
    } else {
      this.buf = { kind, final, session, resultId, text, boundary, audioEnd, lagBase };
    }
    if (boundary || final) {
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
    if (b.kind === "speech") {
      this.stats.speechLagSum += lag;
      this.stats.speechLagN++;
      this.stats.speechLagMax = Math.max(this.stats.speechLagMax, lag);
      log.debug(`[speech] seq=${seq} resultId=${b.resultId} audioEnd=${b.audioEnd.toFixed(2)} lagMs=${Math.round(lag)} final=${b.final} text="${b.text}"`);
      this.send(
        buildSpeechAppend({
          session: b.session,
          n: ++this.speechN,
          seq,
          resultId: b.resultId,
          text: b.text,
          boundary: b.boundary,
          final: b.final,
          audioEnd: b.audioEnd,
        }),
        "speech",
      );
      return;
    }
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
