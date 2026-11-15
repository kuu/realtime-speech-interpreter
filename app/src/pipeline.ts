// Transcription stage: PCM audio frames -> Amazon Transcribe (streaming, partial
// results stabilization, optional multi-language ID) -> LanguageGate (drops non-English
// results; LANGUAGE_FILTER=off bypasses it) -> Segmenter (clause/sentence chunks) -> ChunkPlayer.
//
// The transcript loop never awaits downstream work: the Segmenter is synchronous and
// ChunkPlayer.enqueue() only queues. Translate/Polly/playback run in the player's single
// ordered worker, so a long Japanese chunk can't stall transcription or race another chunk.
//
// The pipeline is decoupled from the audio source: callers provide an async iterable
// of PCM byte frames (from SRT ingest, or a file for local testing).

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
} from "@aws-sdk/client-transcribe-streaming";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { log } from "./log.js";
import { Segmenter } from "./segmenter.js";
import { LanguageGate, createResultSink } from "./language-gate.js";
import { transcribeParams } from "./transcribe-params.js";
import type { ChunkPlayer } from "./chunk-player.js";

const transcribeClient = new TranscribeStreamingClient({ region: config.region });

const TICK_MS = 200;

// Run one input session (one SRT connection or one INPUT_FILE). Resolves when the
// audio input ends and the transcript has been fully flushed into the player.
// Never rejects for Transcribe errors: it logs, flushes, and reopens Transcribe on
// the same input while audio keeps coming.
export async function runPipeline(
  audioFrames: AsyncIterable<Uint8Array>,
  player: ChunkPlayer,
  session: number,
): Promise<void> {
  // Transcribe starts a 15s "no new audio" timer the moment the request opens.
  // Wait for the first real audio frame before starting the stream so a slow-to-
  // connect sender (OBS / mic / SRT caller) does not trip a spurious timeout.
  const iterator = audioFrames[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    log.info(`[session ${session}] no audio received; nothing to do`);
    return;
  }
  log.info(`[session ${session}] first audio received; opening Transcribe stream`);

  let inputEnded = false;
  let carry: Uint8Array | null = first.value;
  let carryAt = Date.now();
  let attempt = 0;
  let consecutiveErrors = 0;

  while (!inputEnded) {
    attempt++;
    // Wall time of Transcribe stream time 0 = when this stream's first frame arrived.
    let t0 = carry ? carryAt : Date.now();
    let active = true;
    const startFrame = carry;
    carry = null;

    // t0 estimate = min over frames of (arrival wall time − audio already fed). Frames can
    // only arrive late, never early, so the minimum ignores bursts (ffmpeg's input probing
    // releases the first seconds at once; buffered frames after a reopen are fed fast).
    let fedMs = 0;
    const bytesPerMs = (config.audio.sampleRateHertz * 2) / 1000;
    // startBurstMs (log only): how late this stream's first frame arrived relative to the t0
    // estimate = the start-up burst (SRT input probing, or audio buffered during a reopen).
    // Logged once after 30 s of audio (t0 has settled by then) or at the end of the stream.
    let firstArrivedAt = -1;
    let burstLogged = false;
    const logBurst = () => {
      if (burstLogged || firstArrivedAt < 0) return;
      burstLogged = true;
      log.info(
        `[session ${session}] stream ${attempt} startBurstMs=${Math.round(firstArrivedAt - t0)} fedMs=${Math.round(fedMs)}`,
      );
    };
    const feed = (frame: Uint8Array, arrivedAt: number): AudioStream => {
      if (firstArrivedAt < 0) firstArrivedAt = arrivedAt;
      t0 = Math.min(t0, arrivedAt - fedMs);
      fedMs += frame.length / bytesPerMs;
      if (fedMs >= 30_000) logBurst();
      return { AudioEvent: { AudioChunk: frame } };
    };

    // Each attempt gets its own generator; once abandoned it stops pulling frames
    // (at most one in-flight frame can be lost on a Transcribe error).
    async function* toTranscribe(): AsyncGenerator<AudioStream> {
      if (startFrame) {
        yield feed(startFrame, t0);
      } else {
        const n = await iterator.next();
        if (n.done) {
          inputEnded = true;
          return;
        }
        t0 = Date.now();
        yield feed(n.value, t0);
      }
      while (active) {
        const next = await iterator.next();
        if (next.done) {
          inputEnded = true;
          return;
        }
        if (!active) return;
        yield feed(next.value, Date.now());
      }
    }

    const segmenter = new Segmenter(config.segmentation, (chunk) =>
      player.enqueue({ ...chunk, t0, session }),
    );
    // LANGUAGE_FILTER=off: the segmenter itself (old behavior); langid: drops non-English results.
    const lf = config.languageFilter;
    const sink = createResultSink(
      lf.mode,
      segmenter,
      {
        source: config.transcribe.languageCode,
        settleWords: lf.settleWords,
        settleMode: lf.settleMode,
        settleWordsDefault: lf.settleWordsDefault,
        settleWordsAfterJa: lf.settleWordsAfterJa,
        jaMemoryMs: lf.jaMemoryMs,
        shortWords: lf.shortWords,
        shortMinConf: lf.shortMinConf,
      },
      () => t0,
    );
    const ticker = setInterval(() => {
      try {
        segmenter.tick(Date.now());
      } catch (err) {
        log.error("[pipeline] tick error:", err);
      }
    }, TICK_MS);

    try {
      const response = await transcribeClient.send(
        new StartStreamTranscriptionCommand({
          ...transcribeParams(config.transcribe, config.audio.sampleRateHertz, lf),
          AudioStream: toTranscribe(),
        }),
      );
      if (!response.TranscriptResultStream) {
        throw new Error("No transcript result stream returned by Transcribe");
      }
      for await (const event of response.TranscriptResultStream) {
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          sink.onResult(result, Date.now());
        }
        consecutiveErrors = 0;
      }
      sink.endOfStream("eof", Date.now());
      if (!inputEnded) {
        log.warn(`[session ${session}] Transcribe stream ${attempt} ended while input continues; reopening`);
      }
    } catch (err) {
      consecutiveErrors++;
      log.error(`[session ${session}] Transcribe stream ${attempt} error:`, err);
      sink.endOfStream("error", Date.now());
    } finally {
      active = false;
      clearInterval(ticker);
      logBurst();
      if (sink instanceof LanguageGate) log.info(sink.summary(attempt));
    }
    if (!inputEnded) {
      // Input keeps buffering in the PcmQueue meanwhile, so nothing is lost by waiting.
      await sleep(Math.min(500 * Math.max(1, consecutiveErrors), 5000));
    }
  }
  log.info(`[session ${session}] transcript stream ended`);
}
