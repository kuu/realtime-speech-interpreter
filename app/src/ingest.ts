// Browser microphone input: wires the event window, the session and the LiveKit ingest room to the real
// services. Started once by main.ts when INPUT_SOURCE=browser, instead of the SRT listener.
import { AudioStream, Room, TrackSource, type RemoteTrackPublication, type Track } from "@livekit/rtc-node";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";
import { log } from "./log.js";
import { IngestSession } from "./ingest-session.js";
import { PublisherWindow } from "./ingest-window.js";
import { IngestRoom, PUBLISHER_IDENTITY, type IngestDeps, type PublicationLike, type RoomLike } from "./ingest-room.js";
import { ssmNotAfterReader } from "./ingest-ssm.js";

export function ttlToSec(v: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(v.trim());
  if (!m) return 4 * 3600;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
}
export function httpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

export class BrowserIngest {
  readonly session: IngestSession;
  private readonly window: PublisherWindow;
  private readonly room: IngestRoom;
  private tick: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const ing = config.ingest;
    this.session = new IngestSession({
      frameBytes: config.audio.frameBytes,
      sampleRate: config.audio.sampleRateHertz,
      graceMs: ing.sessionGraceSec * 1000,
      silenceDb: ing.silenceDb,
      silenceSec: ing.silenceSec,
      maxQueueMs: ing.maxQueueMs,
      levelLogMs: ing.levelLogSec * 1000,
      windowOpen: () => this.window.isOpen(),
      now: () => Date.now(),
      log,
    });
    const closeHook = () => void this.room.removeUntilGone();
    this.window = new PublisherWindow(ssmNotAfterReader(ing.notAfterParam), closeHook, log, ing.notAfterPollSec * 1000);
    const ttlSec = ttlToSec(config.livekit.tokenTtl);
    const lk = config.livekit;
    const deps: IngestDeps = {
      createRoom: () => new Room() as unknown as RoomLike,
      mintToken: async () => {
        const at = new AccessToken(lk.apiKey, lk.apiSecret, { identity: "ingest-app", ttl: ttlSec });
        at.addGrant({ roomJoin: true, room: ing.room, canSubscribe: true, canPublish: false, canPublishData: false });
        return at.toJwt();
      },
      url: lk.url,
      tokenTtlSec: ttlSec,
      openStream: (track) => {
        const stream = new AudioStream(track as Track, config.audio.sampleRateHertz, 1);
        const reader = stream.getReader();
        return {
          frames: (async function* () {
            while (true) {
              const { done, value } = await reader.read();
              if (done) return;
              yield new Uint8Array(value.data.buffer, value.data.byteOffset, value.data.byteLength);
            }
          })(),
          close: () => void reader.cancel().catch(() => {}),
        };
      },
      removeParticipant: async () => {
        const svc = new RoomServiceClient(httpUrl(lk.url), lk.apiKey, lk.apiSecret);
        await svc.removeParticipant(ing.room, PUBLISHER_IDENTITY);
      },
      isMicrophone: (pub: PublicationLike) => (pub as unknown as RemoteTrackPublication).source === TrackSource.SOURCE_MICROPHONE,
      sleep: (ms) => sleep(ms),
      log,
    };
    this.room = new IngestRoom(deps, this.session, this.window);
  }

  /** Reads the end time and starts joining the ingest room (retries in the background; never throws). */
  async start(): Promise<void> {
    await this.window.start();
    this.tick = setInterval(() => this.session.tick(), 50);
    void this.room.start();
    log.info(`[ingest] browser input ready room=${config.ingest.room}`);
  }

  async close(): Promise<void> {
    if (this.tick) clearInterval(this.tick);
    this.window.stop();
    this.session.close();
    await this.room.stop();
  }
}
