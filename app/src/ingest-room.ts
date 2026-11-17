// LiveKit side of the browser input. The app joins the ingest room as `ingest-app` (subscribe only, no
// auto-subscribe), subscribes to one microphone track of `browser-publisher`, and pushes each audio frame straight
// into the IngestSession. It removes the publisher at the event end and never subscribes after it.
// Everything that touches LiveKit goes through `IngestDeps`, so the logic is tested with fakes.
import type { IngestSession } from "./ingest-session.js";
import type { PublisherWindow } from "./ingest-window.js";

export const PUBLISHER_IDENTITY = "browser-publisher";

export interface PublicationLike {
  sid: string;
  source?: unknown;
  kind?: unknown;
  track?: unknown;
  setSubscribed(subscribed: boolean): void;
}
export interface ParticipantLike {
  identity: string;
  trackPublications: Map<string, PublicationLike>;
}
export interface RoomLike {
  remoteParticipants: Map<string, ParticipantLike>;
  on(event: string, cb: (...args: any[]) => void): unknown;
  connect(url: string, token: string, opts: { autoSubscribe: boolean; dynacast: boolean }): Promise<void>;
  disconnect(): Promise<void>;
}
export interface IngestDeps {
  createRoom(): RoomLike;
  mintToken(): Promise<string>;
  url: string;
  tokenTtlSec: number;
  /** Frames of the subscribed track as s16le mono PCM at the pipeline rate. Ends when the track ends or is closed. */
  openStream(track: unknown): { frames: AsyncIterable<Uint8Array>; close(): void };
  removeParticipant(): Promise<void>;
  isMicrophone(pub: PublicationLike): boolean;
  sleep(ms: number): Promise<void>;
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

const RECONNECT_START_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REMOVE_RETRY_MS = 10000;

export class IngestRoom {
  private room: RoomLike | null = null;
  private current: { sid: string; close: () => void } | null = null;
  private stopped = false;
  private removing = false;
  private rejoining = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly d: IngestDeps,
    private readonly session: IngestSession,
    private readonly window: PublisherWindow,
  ) {}

  /** Joins (retrying with backoff) and returns once the first join succeeded or stop() was called. */
  async start(): Promise<void> {
    let delay = RECONNECT_START_MS;
    while (!this.stopped) {
      try {
        await this.join();
        return;
      } catch (err) {
        this.d.log.error(`[ingest] join failed, retry in ${Math.round(delay / 1000)}s:`, err);
        await this.d.sleep(delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  private async join(): Promise<void> {
    const token = await this.d.mintToken();
    const room = this.d.createRoom();
    room.on("participantConnected", (p: ParticipantLike) => this.onParticipant(p));
    room.on("trackPublished", (pub: PublicationLike, p: ParticipantLike) => this.onPublished(pub, p));
    room.on("trackSubscribed", (track: unknown, pub: PublicationLike, p: ParticipantLike) => this.onSubscribed(track, pub, p));
    room.on("trackUnsubscribed", (_t: unknown, pub: PublicationLike, p: ParticipantLike) => this.onGone(pub.sid, p));
    room.on("participantDisconnected", (p: ParticipantLike) => this.onLeft(p));
    room.on("disconnected", () => void this.onConnectionLost(room));
    await room.connect(this.d.url, token, { autoSubscribe: false, dynacast: false });
    this.room = room;
    // Pick up a publisher that was already there; do not wait only for participantConnected.
    for (const p of room.remoteParticipants.values()) {
      if (p.identity === PUBLISHER_IDENTITY) {
        this.d.log.info("[ingest] publisher already present");
        this.onParticipant(p);
      }
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshToken(), Math.max(1000, this.d.tokenTtlSec * 900));
    this.refreshTimer.unref?.();
  }

  private async refreshToken(): Promise<void> {
    if (this.stopped) return;
    this.d.log.info("[ingest] token refreshed");
    const old = this.room;
    this.room = null;
    await this.dropPublisher();
    try { await old?.disconnect(); } catch { /* already gone */ }
    await this.start();
  }

  private async onConnectionLost(room: RoomLike): Promise<void> {
    if (this.stopped || this.room !== room || this.rejoining) return;
    this.rejoining = true;
    this.d.log.error("[ingest] app connection lost, rejoining");
    this.room = null;
    await this.dropPublisher();
    await this.start();
    this.rejoining = false;
    if (!this.stopped) this.d.log.info("[ingest] app reconnected");
  }

  private isPublisher(p: ParticipantLike | undefined): p is ParticipantLike {
    return !!p && p.identity === PUBLISHER_IDENTITY;
  }

  private onParticipant(p: ParticipantLike): void {
    if (!this.isPublisher(p)) return;
    if (!this.window.isOpen()) {
      void this.removeUntilGone();
      return;
    }
    for (const pub of p.trackPublications.values()) this.consider(pub);
  }

  private consider(pub: PublicationLike): void {
    if (!this.window.isOpen() || !this.d.isMicrophone(pub)) return;
    pub.setSubscribed(true);
  }

  private onPublished(pub: PublicationLike, p: ParticipantLike): void {
    if (this.isPublisher(p)) this.consider(pub);
  }

  private onSubscribed(track: unknown, pub: PublicationLike, p: ParticipantLike): void {
    if (!this.isPublisher(p) || !this.d.isMicrophone(pub)) return;
    if (!this.window.isOpen()) {
      pub.setSubscribed(false);
      void this.removeUntilGone();
      return;
    }
    const replaced = this.current !== null;
    if (this.current) this.current.close(); // never feed two tracks
    const stream = this.d.openStream(track);
    const mine = { sid: pub.sid, close: () => stream.close() };
    this.current = mine;
    if (replaced) {
      this.session.handovers++;
      this.d.log.warn("[ingest] publisher replaced previous disconnected reason=DUPLICATE_IDENTITY");
    } else {
      this.d.log.info(`[ingest] publisher joined identity=${PUBLISHER_IDENTITY} trackSid=${pub.sid}`);
    }
    this.session.setPublisherPresent(true);
    void (async () => {
      try {
        for await (const f of stream.frames) {
          if (this.current !== mine) break;
          this.session.pushFrame(f);
        }
      } catch (err) {
        this.d.log.warn("[ingest] audio stream error:", err);
      }
      if (this.current === mine) this.onGone(pub.sid, p, "track ended");
    })();
  }

  private onGone(sid: string, _p?: ParticipantLike, reason = "track unsubscribed"): void {
    if (!this.current || this.current.sid !== sid) return;
    this.current.close();
    this.current = null;
    this.session.setPublisherPresent(false);
    this.d.log.warn(`[ingest] publisher left reason=${reason}`);
  }

  private onLeft(p: ParticipantLike): void {
    if (!this.isPublisher(p) || !this.current) return;
    // Handover in reverse order: the new track may already be current while the old participant leaves.
    if ([...p.trackPublications.values()].some((pub) => pub.sid === this.current?.sid)) {
      this.onGone(this.current.sid, p, "participant disconnected");
    }
  }

  private async dropPublisher(): Promise<void> {
    if (this.current) {
      this.current.close();
      this.current = null;
      this.session.setPublisherPresent(false);
    }
  }

  /** Called when the event window closes, and whenever a publisher shows up while it is closed. */
  async removeUntilGone(): Promise<void> {
    await this.dropPublisher();
    if (this.removing || this.stopped) return;
    this.removing = true;
    try {
      while (!this.stopped && !this.window.isOpen()) {
        try {
          await this.d.removeParticipant();
          return;
        } catch (err) {
          if (isNotFound(err)) return;
          this.d.log.error("[ingest] remove publisher failed, retry:", err);
          await this.d.sleep(REMOVE_RETRY_MS);
        }
      }
    } finally {
      this.removing = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.dropPublisher();
    try { await this.room?.disconnect(); } catch { /* ignore */ }
    this.room = null;
  }
}

export function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | undefined;
  return e?.status === 404 || e?.code === "not_found" || /not.?found/i.test(e?.message ?? "");
}
