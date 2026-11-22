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
import { initReadings, readingsStartupLine, loadReadingsEn, type Readings } from "./polly-readings.js";
import { log } from "./log.js";
import { startSrtListener } from "./srt-source.js";
import { startRtmpListener, assertRtmpConfig } from "./rtmp-source.js";
import { PcmQueue } from "./pcm-queue.js";
import { runPipeline, type PipelineLane } from "./pipeline.js";
import { createSink } from "./audio-sink.js";
import { ChunkPlayer } from "./chunk-player.js";
import { CaptionPublisher } from "./caption-publisher.js";
import { createTranslationEngine, TranslateOnlyEngine, type TranslationEngine } from "./translate-engine.js";
import { parseChannels, type ChannelSpec } from "./channels.js";
import { laneSettingsFor, type LaneSettings } from "./lane-settings.js";
import { JaSegmenter, jaSegmenterOptions } from "./segmenter-ja.js";
import { englishVoiceCheck } from "./polly-voices.js";
import { healthBody, type LaneHealth } from "./health-body.js";
import type { CaptionLane } from "./caption-event.js";
import { pacingDelayMs } from "./input-pacing.js";
import { selectSource } from "./input-source.js";
import { BrowserIngest } from "./ingest.js";

// Build the PCM frame source for one session: either the live SRT listener or a paced file (test).
function buildAudioSource(inputFile: string | undefined, ingest?: BrowserIngest, rtmps = false): {
  frames: AsyncIterable<Uint8Array>;
  stop: () => void;
} {
  if (!inputFile && ingest) return ingest.session.nextSession();
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

  // Live ingest: the RTMP listener (INPUT_SOURCE=rtmps) or the SRT listener. Same queue, same pipeline.
  const tag = rtmps ? "rtmp" : "srt";
  const srt = rtmps ? startRtmpListener() : startSrtListener();
  srt.chunks.on("data", (c: Buffer) => queue.push(Buffer.from(c)));
  srt.chunks.on("end", () => {
    log.info(`[${tag}] stream ended (${queue.totalBytes} bytes)`);
    queue.end();
  });
  srt.chunks.on("error", (err) => {
    log.error(`[${tag}] stdout error:`, err);
    queue.end();
  });
  return { frames: queue.frames$(), stop: srt.stop };
}

// Minimal health endpoint for the Fargate/NLB health check. Loopback by default; the Fargate
// task sets HEALTH_HOST=0.0.0.0 explicitly (the NLB health check needs it).
let laneHealth: { id: string; status: LaneHealth }[] | null = null;
function startHealthServer(): void {
  const port = Number(process.env.HEALTH_PORT ?? 8080);
  const host = process.env.HEALTH_HOST ?? "127.0.0.1";
  createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(healthBody(laneHealth));
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
  // Lanes of this deploy. One default lane (English to Japanese, flat variables) = today's code path, no lane objects.
  const specs = parseChannels(process.env);
  const multi = specs.length > 1;
  const nonDefault = specs[0].source !== "en-US" || specs[0].target !== "ja";
  const useLanes = multi || nonDefault;
  const laneSettings: (LaneSettings | undefined)[] = specs.map((sp, i) => (useLanes ? laneSettingsFor(sp, i) : undefined));
  if (useLanes) {
    for (const l of laneSettings as LaneSettings[]) {
      log.info(
        `  lane ch=${l.id} source=${l.source} target=${l.target} voice=${l.polly.voiceId} engine=${l.translate.engine} ` +
          `terminology=${l.translate.terminologyName || "-"} speed=${l.speed.mode} track=${l.livekit.trackName} topic=${l.livekit.captionTopic}`,
      );
    }
    const jaSeg = config.jaSegmentation;
    if (specs.some((sp) => /^ja(-|$)/i.test(sp.source))) {
      log.info(
        `  ja-segmentation mode=${jaSeg.mode} maxWaitMs=${jaSeg.maxWaitMs}` +
          (jaSeg.mode === "full"
            ? ` sentenceMinChars=${jaSeg.sentenceMinChars} clauseMinChars=${jaSeg.clauseMinChars} maxChars=${jaSeg.maxChars} pauseMs=${jaSeg.pauseMs}`
            : ""),
      );
    }
  }

  interface RunLane {
    spec: ChannelSpec;
    settings: LaneSettings | undefined;
    sink: Awaited<ReturnType<typeof createSink>>;
    engine: TranslationEngine;
    captions: CaptionPublisher;
    player: ChunkPlayer;
    id: string;
  }
  // Builds one lane: sink (connected first so listeners can join before audio starts), engine, captions, player.
  async function buildLane(spec: ChannelSpec, settings: LaneSettings | undefined, index: number): Promise<RunLane> {
    const sink = await createSink(settings);
    await sink.connect();
    // Translation engine (translate | llm). Never throws: any init problem falls back to Translate only.
    let engine: TranslationEngine;
    try {
      engine = await createTranslationEngine(settings ? { lane: settings } : {});
    } catch (err) {
      log.error("LLM ENGINE DISABLED: engine init failed, using Amazon Translate only:", err);
      engine = new TranslateOnlyEngine();
    }
    const llmLine = engine.startupLine();
    if (llmLine) log.info(settings && multi ? `${llmLine} ch=${settings.id}` : llmLine);
    const captionLane: CaptionLane | undefined = settings
      ? { ch: settings.id, lang: settings.target, sourceLang: settings.translate.sourceLanguageCode, first: index === 0 }
      : undefined;
    const captions = settings
      ? new CaptionPublisher(sink, config.captions.enabled, undefined, config.captions.japaneseSpeech, undefined, undefined, captionLane, settings.livekit.captionTopic)
      : new CaptionPublisher(sink, config.captions.enabled, undefined, config.captions.japaneseSpeech);
    log.info(captions.startupLine());
    let readingsEn: Readings | null = null;
    if (settings && settings.target !== "ja") {
      const v = englishVoiceCheck(settings.polly.voiceId, settings.polly.engine);
      if (!v.known) log.warn(`[polly] ch=${settings.id} ${v.note}`);
      if (config.polly.readings === "on") readingsEn = loadReadingsEn(config.polly.readingsFileEn);
    }
    const player = new ChunkPlayer(sink, engine, captions, undefined, settings, multi, readingsEn);
    return { spec, settings, sink, engine, captions, player, id: settings?.id ?? "ja" };
  }
  const running: RunLane[] = [];
  // Lane 1 first: its failure is fatal exactly as before. Lane 2 failing to start is logged and doctored, lane 1 serves.
  running.push(await buildLane(specs[0], laneSettings[0], 0));
  if (multi) {
    const health: { id: string; status: LaneHealth }[] = [{ id: running[0].id, status: "up" }];
    laneHealth = health;
    // Lane 2 gets a start-up deadline: a LiveKit connect or engine init that hangs must not hold lane 1 back.
    const LANE_START_TIMEOUT_MS = 20000;
    try {
      let timedOut = false;
      const building = buildLane(specs[1], laneSettings[1], 1);
      building.then(
        (l) => {
          if (timedOut) void l.sink.disconnect().catch(() => {}); // arrived after the deadline: never used
        },
        () => {},
      );
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`start-up took longer than ${LANE_START_TIMEOUT_MS} ms`));
        }, LANE_START_TIMEOUT_MS);
      });
      try {
        running.push(await Promise.race([building, deadline]));
      } finally {
        clearTimeout(timer);
      }
      health.push({ id: running[1].id, status: "up" });
    } catch (err) {
      const id = (laneSettings[1] as LaneSettings).id;
      log.error(`lane ${id} disabled: ${String(err)} (lane ${running[0].id} keeps running; run scripts/doctor.sh)`);
      health.push({ id, status: "disabled" });
    }
  }
  const first = running[0];
  const logSummary = (label: string) => {
    for (const l of running) {
      log.info(l.player.summary(label));
      const c = l.captions.summaryLine(label);
      if (c) log.info(c);
      const e = l.engine.summaryLine(multi && l.settings ? `${label} ch=${l.settings.id}` : label);
      if (e) log.info(e);
    }
    if (ingest) log.info(ingest.session.summaryLine(label));
  };
  const inputFile = process.env.INPUT_FILE;
  // Exactly one live input: the browser ingest or the SRT listener (started per session below). Never both.
  const kind = selectSource({ inputFile, source: config.input.source });
  const ingest = kind === "browser" ? new BrowserIngest() : undefined;
  if (kind === "rtmps") assertRtmpConfig(); // refuses to start without a valid stream key (never an open listener)
  if (ingest) await ingest.start();
  // Pipeline view of the running lanes (a Japanese-source lane gets the Japanese segmenter).
  const pipelineLanes = (): PipelineLane[] =>
    running.map((l) => ({
      id: l.id,
      source: l.spec.source,
      player: l.player,
      captions: l.captions,
      vocabulary: l.spec.transcribeVocabulary,
      ...(/^ja(-|$)/i.test(l.spec.source) ? { makeSegmenter: (onChunk, tap) => new JaSegmenter(jaSegmenterOptions(config), onChunk, tap) } : {}),
    }));
  let shuttingDown = false;
  let currentStop: (() => void) | null = null;

  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason})`);
    currentStop?.();
    await ingest?.close();
    // ECS stopTimeout is 10 s: give queued chunks up to 8 s to finish playing.
    await Promise.race([Promise.all(running.map((l) => l.player.drain())), sleep(8000)]);
    for (const l of running) l.captions.close();
    logSummary("exit");
    for (const l of running) l.engine.dispose();
    for (const l of running) {
      try {
        await l.sink.disconnect();
      } catch (err) {
        log.warn("sink disconnect error:", err);
      }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  for (let session = 1; !shuttingDown; session++) {
    const src = buildAudioSource(inputFile, ingest, kind === "rtmps");
    currentStop = src.stop;
    try {
      await runPipeline(src.frames, first.player, session, first.captions, useLanes ? pipelineLanes() : undefined);
    } catch (err) {
      log.error(`[session ${session}] pipeline error:`, err);
    }
    src.stop();
    log.info(`[session ${session}] ended; ${running.map((l) => (multi ? `${l.id}=` : "") + l.player.depth()).join(" ")} chunk(s) still queued for playback`);
    logSummary(`session=${session}`);
    if (inputFile) {
      await Promise.all(running.map((l) => l.player.drain()));
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
