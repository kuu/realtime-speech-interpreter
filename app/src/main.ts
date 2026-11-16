// Entry point. Wires the live path:
//   OBS --SRT/Opus--> ffmpeg listener --PCM--> pipeline --chunks--> ChunkPlayer
//   (Translate → Polly) --PCM--> LiveKit --> browsers
//
// SRT mode runs sessions forever: when OBS disconnects (stream stop/reconnect) the
// current session is flushed and played out, and a new SRT listener is started.
// For local testing without OBS, set INPUT_FILE to a raw PCM file (16 kHz mono
// s16le); the app paces it in real time, plays everything out, and exits.

import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { initReadings, readingsStartupLine } from "./polly-readings.js";
import { log } from "./log.js";
import { startSrtListener } from "./srt-source.js";
import { PcmQueue } from "./pcm-queue.js";
import { runPipeline } from "./pipeline.js";
import { createSink } from "./audio-sink.js";
import { ChunkPlayer } from "./chunk-player.js";
import { CaptionPublisher } from "./caption-publisher.js";
import { createTranslationEngine, TranslateOnlyEngine, type TranslationEngine } from "./translate-engine.js";
import { pacingDelayMs } from "./input-pacing.js";

// Build the PCM frame source for one session: either the live SRT listener or a paced file (test).
function buildAudioSource(inputFile: string | undefined): {
  frames: AsyncIterable<Uint8Array>;
  stop: () => void;
} {
  const queue = new PcmQueue(config.audio.frameBytes);

  if (inputFile) {
    const pacing = config.input.pacing;
    log.info(`[input] reading paced PCM file: ${inputFile} pacing=${pacing}`);
    const bytesPerSec = config.audio.sampleRateHertz * 2;
    const frameMs = (config.audio.frameBytes / bytesPerSec) * 1000;
    const stream = createReadStream(inputFile, { highWaterMark: config.audio.frameBytes });
    (async () => {
      try {
        const start = Date.now();
        let sent = 0;
        for await (const chunk of stream) {
          queue.push(Buffer.from(chunk as Uint8Array));
          sent += (chunk as Uint8Array).length;
          // pace to real time (absolute schedule; "sleep" = the old per-frame sleep)
          await sleep(pacingDelayMs(pacing, start, sent, bytesPerSec / 1000, frameMs, Date.now()));
        }
      } catch (err) {
        log.error("[input] file read error:", err);
      }
      log.info(`[input] file ended (${queue.totalBytes} bytes)`);
      queue.end();
    })();
    return { frames: queue.frames$(), stop: () => stream.destroy() };
  }

  // Live SRT ingest.
  const srt = startSrtListener();
  srt.chunks.on("data", (c: Buffer) => queue.push(Buffer.from(c)));
  srt.chunks.on("end", () => {
    log.info(`[srt] stream ended (${queue.totalBytes} bytes)`);
    queue.end();
  });
  srt.chunks.on("error", (err) => {
    log.error("[srt] stdout error:", err);
    queue.end();
  });
  return { frames: queue.frames$(), stop: srt.stop };
}

// Minimal health endpoint for the Fargate/NLB health check. Loopback by default; the Fargate
// task sets HEALTH_HOST=0.0.0.0 explicitly (the NLB health check needs it).
function startHealthServer(): void {
  const port = Number(process.env.HEALTH_PORT ?? 8080);
  const host = process.env.HEALTH_HOST ?? "127.0.0.1";
  createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(port, host, () => log.info(`[health] listening on ${host}:${port}/health`));
}

// A stray async error must never take the live pipeline down.
process.on("unhandledRejection", (reason) => log.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => log.error("uncaughtException:", err));

async function main(): Promise<void> {
  log.info("Simultaneous translation app starting");
  log.info(`  region=${config.region} sink=${config.sink.kind} livekit=${config.livekit.url} room=${config.livekit.roomName}`);
  log.info(`  latencyPreset=${config.latencyPreset}`);
  const s = config.segmentation;
  log.info(
    `  segmentation mode=${s.mode} minWords=${s.minWords} maxWords=${s.maxWords} maxMs=${s.maxMs} ` +
      `pauseMs=${s.pauseMs} stability=${config.transcribe.partialResultsStability} conjunctions=${s.conjunctions.join(",")} ` +
      `mergeShort=${s.mergeShort ? "on" : "off"} sentenceMinWords=${s.sentenceMinWords} ` +
      `sentenceCompleteWords=${s.sentenceCompleteWords} ` +
      `mergePauseMs=${s.mergePauseMs} mergeMaxHoldMs=${s.mergeMaxHoldMs}`,
  );
  log.info(
    `  segmentation-quality danglingGuard=${s.danglingGuard ? "on" : "off"} danglingMaxWords=${s.danglingMaxWords} ` +
      `danglingMaxHoldMs=${s.danglingMaxHoldMs} danglingWords=${s.danglingWords.length > 0 ? s.danglingWords.join(",") : "default"} ` +
      `cutLookaheadMs=${s.cutLookaheadMs} shortSentenceJoin=${s.shortSentenceJoin ? "on" : "off"} ` +
      `shortSentenceWords=${s.shortSentenceWords} shortJoinPauseMs=${s.shortJoinPauseMs}`,
  );
  log.info(readingsStartupLine(initReadings(config.polly.readings, config.polly.readingsFile)));
  const steps = config.playback.speedupSteps.map((x) => `${x.backlogMs}:${x.rate}`).join(",") || "off";
  const sp = config.playback.speed;
  log.info(
    `  playback speedupSteps=${steps} maxBacklogMs=${config.playback.maxBacklogMs} ` +
      `callTimeoutMs=${config.playback.callTimeoutMs} speedMode=${sp.mode} levels=${sp.levels.join(",")} ` +
      `thresholdsMs=${sp.thresholdsMs.join(",")} hysteresisMs=${sp.hysteresisMs} holdMs=${sp.holdMs} ` +
      `urgentMs=${sp.urgentMs} lookahead=${sp.lookahead} msPerChar=${sp.msPerChar} resetGapMs=${sp.resetGapMs}`,
  );
  const fl = config.fillers;
  log.info(
    `  fillers filter=${fl.enabled ? "on" : "off"} words=${fl.words.join(",")} phrases=${fl.phrases.join(",")} ` +
      `ja=${fl.jaPatterns.join(",")}`,
  );
  log.info(
    `  translate engine=${config.translate.engine} formality=${config.translate.formality} correction=${config.correction.enabled ? "on" : "off"}`,
  );
  const lf = config.languageFilter;
  log.info(
    lf.mode === "off"
      ? "  langfilter mode=off"
      : `  langfilter mode=${lf.mode} options=${lf.options.join(",")} settleMode=${lf.settleMode} settleWords=${lf.settleWords} ` +
          (lf.settleMode === "dynamic"
            ? `settleWordsDefault=${lf.settleWordsDefault} settleWordsAfterJa=${lf.settleWordsAfterJa} jaMemoryMs=${lf.jaMemoryMs} `
            : "") +
          `shortWords=${lf.shortWords} shortMinConf=${lf.shortMinConf}`,
  );
  startHealthServer();

  // Connect the output first so listeners can join before audio starts.
  const sink = await createSink();
  await sink.connect();
  // Translation engine (translate | llm). Never throws: any init problem falls back to Translate only.
  let engine: TranslationEngine;
  try {
    engine = await createTranslationEngine();
  } catch (err) {
    log.error("LLM ENGINE DISABLED: engine init failed, using Amazon Translate only:", err);
    engine = new TranslateOnlyEngine();
  }
  const llmLine = engine.startupLine();
  if (llmLine) log.info(llmLine);
  const captions = new CaptionPublisher(sink, config.captions.enabled, undefined, config.captions.japaneseSpeech);
  log.info(captions.startupLine());
  const player = new ChunkPlayer(sink, engine, captions);
  const logSummary = (label: string) => {
    log.info(player.summary(label));
    const c = captions.summaryLine(label);
    if (c) log.info(c);
    const l = engine.summaryLine(label);
    if (l) log.info(l);
  };

  const inputFile = process.env.INPUT_FILE;
  let shuttingDown = false;
  let currentStop: (() => void) | null = null;

  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason})`);
    currentStop?.();
    // ECS stopTimeout is 10 s: give queued chunks up to 8 s to finish playing.
    await Promise.race([player.drain(), sleep(8000)]);
    captions.close();
    logSummary("exit");
    engine.dispose();
    try {
      await sink.disconnect();
    } catch (err) {
      log.warn("sink disconnect error:", err);
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  for (let session = 1; !shuttingDown; session++) {
    const src = buildAudioSource(inputFile);
    currentStop = src.stop;
    try {
      await runPipeline(src.frames, player, session, captions);
    } catch (err) {
      log.error(`[session ${session}] pipeline error:`, err);
    }
    src.stop();
    log.info(`[session ${session}] ended; ${player.depth()} chunk(s) still queued for playback`);
    logSummary(`session=${session}`);
    if (inputFile) {
      await player.drain();
      await shutdown("input file ended");
      return;
    }
    // OBS stopped / reconnecting: keep playing the tail and listen again.
    await sleep(1000);
  }
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
