// Audio output abstraction. Production uses LiveKit; local tests can write the
// synthesized PCM to a file (AUDIO_SINK=file, OUTPUT_FILE=...).

import { closeSync, openSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { log } from "./log.js";
import type { LaneSettings } from "./lane-settings.js";

export interface AudioSink {
  connect(): Promise<void>;
  // Queue s16le mono PCM for playout. Resolves once all of it has been handed to
  // the output (which may still be playing up to ~1 s of it). Returns bytes accepted.
  pushPcm(pcm: Buffer): Promise<number>;
  // Audio queued in the output but not yet played (ms).
  queuedMs(): number;
  // Optional data channel (live captions). The file sink has none: no captions are sent there.
  publishData?(payload: Uint8Array, topic: string): Promise<void>;
  // Resolves when all queued audio has played.
  waitForPlayout(): Promise<void>;
  disconnect(): Promise<void>;
}

// Writes exact PCM bytes to a file while emulating LiveKit AudioSource pacing
// (1000 ms queue, real-time playout clock), so timing/backlog behave like production.
export class FileAudioSink implements AudioSink {
  private fd: number | null = null;
  private playEnd = 0; // wall ms at which queued audio finishes playing
  private readonly bytesPerMs: number;
  private static readonly QUEUE_MS = 1000;

  constructor(
    private readonly path: string,
    sampleRate: number,
  ) {
    this.bytesPerMs = (sampleRate * 2) / 1000;
  }

  async connect(): Promise<void> {
    this.fd = openSync(this.path, "w");
    log.info(`[file-sink] writing PCM to ${this.path} (test sink; LiveKit not used)`);
  }

  async pushPcm(pcm: Buffer): Promise<number> {
    if (this.fd === null) throw new Error("file sink not connected");
    const step = Math.round(this.bytesPerMs * 100) & ~1; // 100 ms pieces, even bytes
    let written = 0;
    for (let off = 0; off < pcm.length; off += step) {
      const piece = pcm.subarray(off, Math.min(off + step, pcm.length));
      const now = Date.now();
      if (this.playEnd < now) this.playEnd = now;
      const ahead = this.playEnd - now;
      if (ahead > FileAudioSink.QUEUE_MS) await sleep(ahead - FileAudioSink.QUEUE_MS);
      written += writeSync(this.fd, piece);
      this.playEnd += piece.length / this.bytesPerMs;
    }
    return written;
  }

  queuedMs(): number {
    return Math.max(0, this.playEnd - Date.now());
  }

  async waitForPlayout(): Promise<void> {
    const ms = this.queuedMs();
    if (ms > 0) await sleep(ms);
  }

  async disconnect(): Promise<void> {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

// One sink per lane. No lane = lane 1 of today. A lane other than the first writes its own file (OUTPUT_FILE.<id>) and
// uses its own LiveKit identity and track in the same room.
export async function createSink(lane?: LaneSettings): Promise<AudioSink> {
  const sampleRate = lane?.polly.sampleRateHertz ?? config.polly.sampleRateHertz;
  if (config.sink.kind === "file") {
    const path = lane && lane.index > 0 ? `${config.sink.outputFile}.${lane.id}` : config.sink.outputFile;
    return new FileAudioSink(path, sampleRate);
  }
  // Imported lazily so file-sink runs never load the LiveKit native module.
  const { LiveKitAudioSink } = await import("./livekit-sink.js");
  return new LiveKitAudioSink(sampleRate, lane ? { roomName: lane.livekit.roomName, identity: lane.livekit.identity, trackName: lane.livekit.trackName } : undefined);
}
