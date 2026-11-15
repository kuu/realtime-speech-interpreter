// LiveKit audio sink: connects a headless publisher to a room and streams PCM
// (s16le mono) audio as evenly-sized 10ms AudioFrames. @livekit/rtc-node's
// AudioSource queues and paces playout, so clean Polly PCM produces glitch-free audio.

import {
  Room,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  AudioFrame,
  dispose,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import type { AudioSink } from "./audio-sink.js";
import { config } from "./config.js";
import { log } from "./log.js";

export class LiveKitAudioSink implements AudioSink {
  private room = new Room();
  private source: AudioSource;
  private readonly sampleRate: number;
  private readonly channels = 1;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.source = new AudioSource(sampleRate, this.channels);
  }

  async connect(): Promise<void> {
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: "publisher-app",
      ttl: config.livekit.tokenTtl,
    });
    at.addGrant({
      roomJoin: true,
      room: config.livekit.roomName,
      canPublish: true,
      canSubscribe: false,
    });
    const token = await at.toJwt();

    await this.room.connect(config.livekit.url, token, {
      autoSubscribe: false,
      dynacast: false,
    });

    const track = LocalAudioTrack.createAudioTrack("translation-audio", this.source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, options);
    log.info(`[livekit] connected to ${config.livekit.url}, published audio track`);
  }

  // Push an s16le mono PCM buffer as 10ms AudioFrames (last frame padded with silence).
  // Must have a single caller at a time (the ChunkPlayer worker): concurrent writers on
  // one AudioSource made the native side reject frames ("InvalidState - failed to
  // capture frame"). A rejected frame is retried once, then skipped (logged) so one
  // bad frame can't abort the rest of the chunk. Returns the PCM bytes accepted.
  async pushPcm(pcm: Buffer): Promise<number> {
    const samplesPer10ms = (this.sampleRate / 1000) * 10;
    const bytesPerFrame = samplesPer10ms * 2;
    let accepted = 0;
    let failedFrames = 0;
    let lastErr: unknown;
    for (let off = 0; off < pcm.length; off += bytesPerFrame) {
      const slice = pcm.subarray(off, Math.min(off + bytesPerFrame, pcm.length));
      const samples = new Int16Array(samplesPer10ms);
      // Copy (Buffer offsets aren't guaranteed to be 2-byte aligned for Int16Array views).
      const usable = slice.length & ~1;
      for (let i = 0; i < usable / 2; i++) samples[i] = slice.readInt16LE(i * 2);
      const frame = new AudioFrame(samples, this.sampleRate, this.channels, samplesPer10ms);
      try {
        await this.source.captureFrame(frame);
        accepted += usable;
      } catch (err) {
        lastErr = err;
        await sleep(20);
        try {
          await this.source.captureFrame(frame);
          accepted += usable;
        } catch (err2) {
          lastErr = err2;
          failedFrames++;
        }
      }
    }
    if (failedFrames > 0) {
      log.warn(`[livekit] ${failedFrames} frame(s) rejected by AudioSource: ${String(lastErr)}`);
    }
    return accepted;
  }

  queuedMs(): number {
    return this.source.queuedDuration;
  }

  async waitForPlayout(): Promise<void> {
    await this.source.waitForPlayout();
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
    await dispose();
  }
}
