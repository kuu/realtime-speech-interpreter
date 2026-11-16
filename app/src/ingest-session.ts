// Session state of the browser input. Real audio frames go straight into the session's PcmQueue (the same queue
// type the SRT and file paths use) with no delay. The only thing added on the audio path is a silence filler: when
// no real audio arrived for 100 ms during an open session inside the event window, one 100 ms silent frame is
// pushed, so Transcribe keeps receiving audio across a handover or a short drop.
//
// A session starts at the first real frame, and ends when no publisher has been present for graceMs (a handover
// inside that time is the same session). With no publisher and no session nothing is sent, so no Transcribe
// stream is opened and nothing is billed.
import { PcmQueue } from "./pcm-queue.js";
import { LevelTracker } from "./ingest-silence.js";
export interface SessionLog {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
}
export interface SessionOptions {
  frameBytes: number;
  sampleRate: number;
  graceMs: number;
  silenceDb: number;
  silenceSec: number;
  maxQueueMs: number;
  levelLogMs: number;
  windowOpen: () => boolean;
  now: () => number;
  log: SessionLog;
}
const FILL_MS = 100;
export class IngestSession {
  private queue: PcmQueue | null = null;
  private present = false;
  private lastPresentAt = 0;
  private lastRealAt = 0;
  private noPublisherSince: number;
  private lastNoPublisherLog: number;
  private lastLevelLog = 0;
  private lastSilentLog = 0;
  private waiter: (() => void) | null = null;
  private closed = false;
  private readonly level: LevelTracker;
  private readonly bytesPerMs: number;
  handovers = 0;
  silentFillMs = 0;
  droppedMs = 0;
  sessions = 0;
  constructor(private readonly o: SessionOptions) {
    this.level = new LevelTracker(o.silenceDb);
    this.bytesPerMs = (o.sampleRate * 2) / 1000;
    this.noPublisherSince = this.lastNoPublisherLog = o.now();
  }
  get open(): boolean {
    return this.queue !== null;
  }
  setPublisherPresent(present: boolean): void {
    const now = this.o.now();
    if (present && !this.present) this.noPublisherSince = now;
    if (!present && this.present) {
      this.noPublisherSince = this.lastNoPublisherLog = now;
    }
    this.present = present;
    if (present) this.lastPresentAt = now;
  }
  /** One real audio frame (s16le mono at sampleRate) from the publisher. */
  pushFrame(pcm: Uint8Array): void {
    if (this.closed || !this.o.windowOpen()) return;
    const now = this.o.now();
    if (!this.queue) this.openSession(now);
    const q = this.queue as PcmQueue;
    this.lastRealAt = now;
    this.lastPresentAt = this.present ? now : this.lastPresentAt;
    this.level.observe(pcm, pcm.length / this.bytesPerMs);
    q.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length));
    const dropped = q.trimTo(this.o.maxQueueMs * this.bytesPerMs);
    if (dropped > 0) this.droppedMs += dropped / this.bytesPerMs;
  }
  private openSession(now: number): void {
    this.queue = new PcmQueue(this.o.frameBytes);
    this.sessions++;
    this.lastRealAt = now;
    this.lastPresentAt = now;
    this.level.reset();
    this.o.log.info("[ingest] session started");
    this.signal();
  }
  /** Called about every 50 ms. Emits the silence filler, closes the session after the grace time, writes the log lines. */
  tick(): void {
    if (this.closed) return;
    const now = this.o.now();
    if (!this.present && this.o.windowOpen() && now - this.lastNoPublisherLog >= 10000) {
      this.lastNoPublisherLog = now;
      this.o.log.warn(`[ingest] no publisher for ${Math.round((now - this.noPublisherSince) / 1000)}s`);
    }
    const q = this.queue;
    if (!q) return;
    if (this.present) this.lastPresentAt = now;
    else if (now - this.lastPresentAt >= this.o.graceMs) {
      this.endSession();
      return;
    }
    if (this.o.windowOpen() && now - this.lastRealAt >= FILL_MS) {
      q.push(Buffer.alloc(Math.round(FILL_MS * this.bytesPerMs)));
      this.silentFillMs += FILL_MS;
      this.lastRealAt = now;
    }
    if (this.present && now - this.lastLevelLog >= this.o.levelLogMs) {
      this.lastLevelLog = now;
      this.o.log.info(`[ingest] level rmsDb=${this.level.rmsDb.toFixed(1)} silentMs=${this.level.silentMs} droppedMs=${Math.round(this.droppedMs)}`);
    }
    if (this.present && this.level.silentMs >= this.o.silenceSec * 1000 && now - this.lastSilentLog >= 10000) {
      this.lastSilentLog = now;
      this.o.log.warn(`[ingest] silent ${Math.round(this.level.silentMs / 1000)}s rmsDb=${this.level.rmsDb.toFixed(1)}`);
    }
  }
  private endSession(): void {
    const q = this.queue;
    this.queue = null;
    this.o.log.info("[ingest] session ended (no publisher for the grace time)");
    q?.end();
  }
  /** One session's frame source for runPipeline. Yields nothing until the first real frame arrives. */
  nextSession(): { frames: AsyncIterable<Uint8Array>; stop: () => void } {
    const self = this;
    async function* frames(): AsyncGenerator<Uint8Array> {
      while (!self.closed && !self.queue) await new Promise<void>((r) => (self.waiter = r));
      if (self.closed || !self.queue) return;
      yield* self.queue.frames$();
    }
    return { frames: frames(), stop: () => this.stopCurrent() };
  }
  private stopCurrent(): void {
    if (this.queue) this.endSession();
  }
  private signal(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  close(): void {
    this.closed = true;
    this.stopCurrent();
    this.signal();
  }
  summaryLine(label: string): string {
    return `[ingest] summary ${label} sessions=${this.sessions} handovers=${this.handovers} silentFillMs=${this.silentFillMs} droppedMs=${Math.round(this.droppedMs)}`;
  }
}
