// SRT ingest source. The app is the SRT LISTENER: it spawns ffmpeg (with libsrt)
// bound to an SRT listener URL, which waits for a sender (OBS in caller mode) to
// connect, then demuxes and decodes the audio to raw 16-bit mono PCM on stdout.
// ffmpeg handles the SRT wire protocol and codec (Opus/AAC), which Node cannot do
// natively; the app decodes to PCM regardless of the wire codec.

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { config } from "./config.js";
import { log } from "./log.js";

export interface SrtSource {
  chunks: Readable; // raw PCM byte stream (ffmpeg stdout)
  stop: () => void;
}

function buildListenerUrl(): string {
  const params = new URLSearchParams({
    mode: "listener",
    latency: String(config.srt.latencyMs * 1000), // ffmpeg SRT latency is microseconds
    // Wait for a caller to connect instead of exiting immediately. In microseconds;
    // a large value effectively means "keep listening" until a sender arrives.
    listen_timeout: String(config.srt.listenTimeoutSec * 1_000_000),
  });
  if (config.srt.passphrase) {
    params.set("passphrase", config.srt.passphrase);
    params.set("pbkeylen", "16");
  }
  return `srt://${config.srt.listenHost}:${config.srt.listenPort}?${params.toString()}`;
}

// ffmpeg arguments for the listener. analyzeMs > 0 limits input probing (-analyzeduration,
// an input option, so it must precede -i): with ffmpeg's default (~5 s for mpegts) the first
// seconds of every connection are held and then released at once, and a language-ID
// Transcribe stream keeps that burst as a permanent lag. 0 = ffmpeg default (revert).
export function listenerArgs(url: string, analyzeMs: number, channels: number, sampleRate: number): string[] {
  return [
    "-hide_banner",
    "-loglevel", "warning",
    ...(analyzeMs > 0 ? ["-analyzeduration", String(Math.round(analyzeMs * 1000))] : []),
    "-i", url,
    "-vn",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ac", String(channels),
    "-ar", String(sampleRate),
    "pipe:1",
  ];
}

export function startSrtListener(): SrtSource {
  const url = buildListenerUrl();
  const args = listenerArgs(url, config.srt.analyzeMs, config.audio.channels, config.audio.sampleRateHertz);

  log.info(`[srt] listening on port ${config.srt.listenPort} (listener mode) analyzeMs=${config.srt.analyzeMs}`);
  const ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  ff.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) log.debug(`[ffmpeg] ${line}`);
  });
  ff.on("exit", (code, signal) => {
    log.info(`[srt] ffmpeg exited code=${code} signal=${signal}`);
  });

  if (!ff.stdout) throw new Error("ffmpeg stdout is not available");

  return {
    chunks: ff.stdout,
    stop: () => {
      if (!ff.killed) ff.kill("SIGTERM");
    },
  };
}
