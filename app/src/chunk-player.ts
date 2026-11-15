// ChunkPlayer: the ONLY consumer of committed English chunks and the ONLY caller of
// sink.pushPcm. One async worker processes chunks strictly in FIFO order:
// corrections → Translate → Polly → play. A chunk is always played fully; if speech
// backs up, chunks play back-to-back (optionally faster via SSML prosody rate).
// Failures are logged per chunk and never propagate (the worker can't reject).

import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import type { AudioSink } from "./audio-sink.js";
import { config } from "./config.js";
import { applyCorrections } from "./corrections.js";
import { withTimeout } from "./translate-call.js";
import { TranslateOnlyEngine, type EngineResult, type TranslationEngine } from "./translate-engine.js";
import { ContextBuffer } from "./llm-context.js";
import { filterEnglish, filterJapanese, hasWords } from "./fillers.js";
import { log } from "./log.js";
import type { Chunk } from "./segmenter.js";
import { SpeedController, spokenChars, synthesizeWithFallback } from "./speed-control.js";
import { activeReadings } from "./polly-readings.js";
import type { CaptionPublisher } from "./caption-publisher.js";

export interface QueuedChunk extends Chunk {
  t0: number; // wall ms corresponding to Transcribe stream time 0
  session: number;
}

interface Item extends QueuedChunk {
  seq: number;
}

const pollyClient = new PollyClient({ region: config.region, maxAttempts: 3 });

async function synthesizeOnce(text: string, ssml: boolean): Promise<Buffer> {
  return withTimeout(async (abortSignal) => {
    const res = await pollyClient.send(
      new SynthesizeSpeechCommand({
        Text: text,
        TextType: ssml ? "ssml" : "text",
        VoiceId: config.polly.voiceId as any,
        Engine: config.polly.engine as any,
        OutputFormat: "pcm",
        SampleRate: String(config.polly.sampleRateHertz),
      }),
      { abortSignal },
    );
    const parts: Buffer[] = [];
    if (res.AudioStream) {
      for await (const part of res.AudioStream as AsyncIterable<Uint8Array>) {
        parts.push(Buffer.from(part));
      }
    }
    return Buffer.concat(parts);
  });
}

// rate 100 and no readings hit = plain text. Otherwise SSML (readings and/or prosody); falls back
// to plain text if Polly rejects the SSML.
export type Synthesizer = (text: string, rate: number, tag: string) => Promise<{ pcm: Buffer; rate: number; hits: number }>;
async function synthesize(text: string, rate: number, tag: string): Promise<{ pcm: Buffer; rate: number; hits: number }> {
  return synthesizeWithFallback(text, rate, activeReadings(), synthesizeOnce, (err) =>
    log.warn(`${tag} SSML synth failed, retrying as plain text: ${String(err)}`),
  );
}
export class ChunkPlayer {
  private queue: Item[] = [];
  private busy = false;
  private seq = 0;
  private wake: (() => void) | null = null;
  private idleWaiters: (() => void)[] = [];
  readonly stats = {
    committed: 0,
    played: 0,
    failed: 0,
    synthBytes: 0,
    writtenBytes: 0,
    sumE2eFirst: 0,
    sumE2eLast: 0,
    maxBacklogMs: 0, // max projected backlog at synth time (incl. dropped chunks)
    maxE2eLast: 0, // max actual backlog of played chunks
    sped: 0,
    dropped: 0,
    skipped: 0, // filler-only chunks (nothing to say)
  };
  // Running estimates of Translate / Polly time, used to project a chunk's start time.
  private estTranslateMs = 150;
  private estSynthMs = 400;
  private readonly speed = new SpeedController(config.playback.speed);
  // Wall time when the last pushed audio finishes playing (for the speed reset after silence).
  private lastAudioEndWall = Number.NEGATIVE_INFINITY;

  // Context of the last chunks that were committed to playback (LLM engine only; size 0 otherwise).
  private readonly ctx: ContextBuffer;

  constructor(
    private readonly sink: AudioSink,
    private readonly engine: TranslationEngine = new TranslateOnlyEngine(),
    // Live captions: undefined (or not enabled) = no timers, no events, no behaviour change.
    private readonly captions?: CaptionPublisher,
    private readonly synth: Synthesizer = synthesize,
  ) {
    this.ctx = new ContextBuffer(engine.contextChunks, engine.contextResetMs);
    void this.worker();
  }

  // Synchronous: never blocks the transcript loop.
  enqueue(chunk: QueuedChunk): void {
    const item: Item = { ...chunk, seq: ++this.seq };
    this.queue.push(item);
    this.stats.committed++;
    const lastWordWall = chunk.t0 + chunk.audioEnd * 1000;
    const results = Object.entries(chunk.resultCounts)
      .map(([id, n]) => (Object.keys(chunk.resultCounts).length > 1 ? `${id.slice(0, 8)}:${n}` : id.slice(0, 8)))
      .join(",");
    log.info(
      `[chunk ${item.seq}] COMMIT reason=${chunk.reason} mode=${config.segmentation.mode} words=${chunk.words} ` +
        (chunk.merged ? `merged=${chunk.merged} ` : "") +
        `result=${results} audio=${chunk.audioStart.toFixed(2)}-${chunk.audioEnd.toFixed(2)}s ` +
        `commitLagMs=${Math.round(chunk.committedAt - lastWordWall)} queueDepth=${this.depth()} en="${chunk.english}"`,
    );
    this.signal();
  }

  // Chunks committed but not yet fully handed to the sink.
  depth(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  // Resolves when every queued chunk has been processed and its audio has played.
  async drain(): Promise<void> {
    if (this.queue.length > 0 || this.busy) {
      await new Promise<void>((r) => this.idleWaiters.push(r));
    }
    await this.sink.waitForPlayout();
  }

  summary(label: string): string {
    const s = this.stats;
    const avg = (v: number) => (s.played ? Math.round(v / s.played) : 0);
    return (
      `[summary] ${label} committed=${s.committed} played=${s.played} dropped=${s.dropped} skipped=${s.skipped} failed=${s.failed} ` +
      `synthBytes=${s.synthBytes} writtenBytes=${s.writtenBytes} sped=${s.sped} ` +
      `avgE2eFirstWordMs=${avg(s.sumE2eFirst)} avgE2eLastWordMs=${avg(s.sumE2eLast)} ` +
      `maxBacklogMs=${Math.round(s.maxBacklogMs)} maxPlayedBacklogMs=${Math.round(s.maxE2eLast)} queueDepth=${this.depth()}`
    );
  }

  private signal(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async worker(): Promise<void> {
    for (;;) {
      const item = this.queue.shift();
      if (!item) {
        const waiters = this.idleWaiters.splice(0);
        for (const w of waiters) w();
        await new Promise<void>((r) => (this.wake = r));
        continue;
      }
      this.busy = true;
      try {
        await this.process(item);
      } catch (err) {
        // process() handles its own errors; this is a last-resort guard.
        this.stats.failed++;
        log.error(`[chunk ${item.seq}] FAILED stage=internal err=${String(err)}`);
      } finally {
        this.busy = false;
      }
    }
  }

  private async process(c: Item): Promise<void> {
    const tag = `[chunk ${c.seq}]`;
    const f = config.fillers;
    const enFiltered = f.enabled
      ? filterEnglish(c.english, f.words, f.phrases)
      : { text: c.english, removed: [] as string[] };
    const fillers = [...enFiltered.removed];
    if (!hasWords(enFiltered.text)) {
      // Filler-only chunk: nothing to translate. Its words were committed (offset advanced)
      // by the segmenter, so nothing is lost or re-emitted.
      this.stats.skipped++;
      log.info(`${tag} SKIPPED reason=filler-only fillers="${fillers.join(",")}" en="${c.english}"`);
      return;
    }
    const { text: english, applied } = config.correction.enabled
      ? applyCorrections(enFiltered.text)
      : { text: enFiltered.text, applied: [] as string[] };

    // Cheap pre-check before spending a Translate call (estimate includes translate+synth).
    if (this.dropForBacklog(c, this.projectedBacklogMs(c, this.estTranslateMs + this.estSynthMs))) return;

    // LLM engine only: when playback is already this far behind, this chunk goes to Translate.
    const forceTranslate =
      this.engine.skipBacklogMs > 0 &&
      this.projectedBacklogMs(c, this.estTranslateMs + this.estSynthMs) > this.engine.skipBacklogMs;
    const srcStartWall = c.t0 + c.audioStart * 1000;
    const previous = this.ctx.prepare(c.session, srcStartWall);

    const tStart = Date.now();
    let japanese: string;
    let result: EngineResult;
    try {
      result = await this.engine.translate({ text: english, previous, forceTranslate });
      japanese = result.text;
    } catch (err) {
      this.stats.failed++;
      log.error(`${tag} FAILED stage=translate err=${String(err)} en="${english}"`);
      return;
    }
    const tTranslated = Date.now();
    this.logEngineFallback(tag, result, english);
    if (f.enabled && japanese) {
      const jaFiltered = filterJapanese(japanese, f.jaPatterns);
      if (jaFiltered.removed.length > 0) {
        fillers.push(...jaFiltered.removed);
        if (!hasWords(jaFiltered.text)) {
          this.stats.skipped++;
          log.info(`${tag} SKIPPED reason=ja-filler-only fillers="${fillers.join(",")}" ja="${japanese}" en="${english}"`);
          return;
        }
        japanese = jaFiltered.text;
      }
    }
    if (!japanese) {
      this.stats.failed++;
      log.warn(`${tag} FAILED stage=translate err=empty-translation en="${english}"`);
      return;
    }

    this.estTranslateMs = ema(this.estTranslateMs, tTranslated - tStart);

    // Backlog at synth time = projected start of this chunk's Japanese audio relative to
    // its last English word (audio still queued in the sink + expected synth time).
    const sinkQueuedMs = this.sink.queuedMs();
    const backlogMs = this.projectedBacklogMs(c, this.estSynthMs);
    if (this.dropForBacklog(c, backlogMs)) return;
    this.stats.maxBacklogMs = Math.max(this.stats.maxBacklogMs, backlogMs);
    const sp = config.playback.speed;
    const estJaMs = sp.msPerChar * spokenChars(japanese);
    const d = this.speed.decide({
      backlogMs,
      estJaMs,
      enSpanMs: (c.audioEnd - c.audioStart) * 1000,
      idleGapMs: Date.now() + this.estSynthMs - this.lastAudioEndWall,
    });
    const wantRate = d.rate;

    let pcm: Buffer;
    let rate: number;
    let readingsHits: number;
    try {
      ({ pcm, rate, hits: readingsHits } = await this.synth(japanese, wantRate, tag));
    } catch (err) {
      this.stats.failed++;
      log.error(`${tag} FAILED stage=synth err=${String(err)} ja="${japanese}"`);
      return;
    }
    const tSynth = Date.now();
    this.estSynthMs = ema(this.estSynthMs, tSynth - tTranslated);
    if (rate !== 100) this.stats.sped++;
    this.stats.synthBytes += pcm.length;
    const audioMs = Math.round(pcm.length / ((config.polly.sampleRateHertz * 2) / 1000));
    this.speed.recordAudio(audioMs);
    // The chunk is committed to playback: later LLM requests see what the listener actually heard.
    this.ctx.push({ en: english, ja: japanese, session: c.session, srcEndWall: c.t0 + c.audioEnd * 1000 });
    const corr = applied.length ? ` [corrected: ${applied.join(", ")}]` : "";
    const fill = fillers.length ? ` fillers="${fillers.join(",")}" enTranslated="${english}"` : "";
    log.info(
      `${tag} SYNTH translateMs=${tTranslated - tStart} synthMs=${tSynth - tTranslated} level=${d.level} rate=${rate} ` +
        `backlogMs=${Math.round(backlogMs)} signalMs=${Math.round(d.signalMs)} estMs=${Math.round(estJaMs)} ` +
        `speedWhy=${d.why} sinkQueuedMs=${Math.round(sinkQueuedMs)} queueDepth=${this.depth()}${engineFields(result)} readings=${readingsHits} ` +
        `pcmBytes=${pcm.length} audioMs=${audioMs} ja="${japanese}"${fill}${corr}`,
    );

    const playStart = Date.now();
    const queuedAtPush = this.sink.queuedMs();
    let written = 0;
    // Live captions: the caption goes out when the first sample of this chunk leaves the sink queue
    // (= when it is heard), not when pushPcm returns (it can wait up to ~1 s on the sink queue).
    // Armed before the push, cleared if the push fails: failed chunks never get a caption.
    let captionTimer: NodeJS.Timeout | null = null;
    const captions = this.captions;
    if (captions?.active) {
      const startAt = playStart + queuedAtPush;
      captionTimer = setTimeout(
        () =>
          captions.sendCaption({
            session: c.session,
            chunkSeq: c.seq,
            text: japanese,
            sourceText: english,
            startAt,
            durationMs: audioMs,
          }),
        Math.max(0, startAt - Date.now()),
      );
    }
    try {
      written = await this.sink.pushPcm(pcm);
    } catch (err) {
      if (captionTimer) clearTimeout(captionTimer);
      this.stats.failed++;
      log.error(`${tag} FAILED stage=play err=${String(err)}`);
      return;
    }
    if (written === 0 && captionTimer) clearTimeout(captionTimer); // nothing was heard
    this.stats.writtenBytes += written;
    this.stats.played++;
    // When the first Japanese sample is heard, relative to the English words.
    const heardAt = playStart + queuedAtPush;
    this.lastAudioEndWall = heardAt + audioMs;
    const e2eFirst = heardAt - (c.t0 + c.audioStart * 1000);
    const e2eLast = heardAt - (c.t0 + c.audioEnd * 1000);
    this.stats.sumE2eFirst += e2eFirst;
    this.stats.sumE2eLast += e2eLast;
    this.stats.maxE2eLast = Math.max(this.stats.maxE2eLast, e2eLast);
    const level = written === pcm.length ? "info" : "warn";
    log[level](
      `${tag} PLAYED writtenBytes=${written} pcmBytes=${pcm.length} waitMs=${playStart - tSynth} ` +
        `backlogMs=${Math.round(e2eLast)} e2eFirstWordMs=${Math.round(e2eFirst)} e2eLastWordMs=${Math.round(e2eLast)}`,
    );
  }

  // WARN lines for chunks the LLM engine could not serve. breaker-open, skip-backlog and
  // glossary-unavailable are expected states (already visible in SYNTH and the BREAKER/startup lines).
  private logEngineFallback(tag: string, r: EngineResult, english: string): void {
    if (r.engine !== "fallback") return;
    if (r.rejected) {
      log.warn(
        `${tag} LLM_REJECT rule=${r.rejected.rule} detail="${oneLine(r.detail ?? "")}" ` +
          `ja="${oneLine(r.rejected.ja)}" en="${english}"`,
      );
    } else if (!QUIET_REASONS.has(r.fallbackReason ?? "")) {
      log.warn(
        `${tag} LLM_FALLBACK reason=${r.fallbackReason} llmMs=${r.llmMs ?? 0} detail="${oneLine(r.detail ?? "")}" en="${english}"`,
      );
    }
  }

  // How late (ms) this chunk's Japanese would start relative to its last English word,
  // if its remaining preparation takes `prepMs`.
  private projectedBacklogMs(c: Item, prepMs: number): number {
    return Date.now() + this.sink.queuedMs() + prepMs - (c.t0 + c.audioEnd * 1000);
  }

  // Hard latency cap: drop this (oldest unplayed) chunk if it would start too late and a
  // newer chunk is waiting. The newest chunk is always kept; nothing already handed to the
  // sink is ever cut.
  private dropForBacklog(c: Item, backlogMs: number): boolean {
    const cap = config.playback.maxBacklogMs;
    if (cap <= 0 || backlogMs <= cap || this.queue.length === 0) return false;
    this.stats.dropped++;
    this.stats.maxBacklogMs = Math.max(this.stats.maxBacklogMs, backlogMs);
    log.warn(
      `[chunk ${c.seq}] DROPPED reason=backlog backlogMs=${Math.round(backlogMs)} capMs=${cap} ` +
        `newerQueued=${this.queue.length} en="${c.english}"`,
    );
    return true;
  }
}

const QUIET_REASONS = new Set(["breaker-open", "skip-backlog", "glossary-unavailable"]);

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/"/g, "'").slice(0, 120);
}

// SYNTH fields between queueDepth= and pcmBytes= (e2e/lib/report.py parses these).
function engineFields(r: EngineResult): string {
  if (r.engine === "translate") return " engine=translate";
  if (r.engine === "llm") {
    const u = r.usage;
    return (
      ` engine=llm llmMs=${r.llmMs ?? 0} inTok=${u?.inputTokens ?? 0} outTok=${u?.outputTokens ?? 0} ` +
      `cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheWriteInputTokens ?? 0}`
    );
  }
  return ` engine=fallback fallbackReason=${r.fallbackReason}` + (r.llmMs !== undefined ? ` llmMs=${r.llmMs}` : "");
}

function ema(prev: number, sample: number): number {
  return prev * 0.7 + sample * 0.3;
}
