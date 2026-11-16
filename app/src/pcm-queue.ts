// Decouples a fast/bursty PCM byte source (ffmpeg stdout) from a slower consumer,
// re-chunking into fixed-size frames. Draining eagerly prevents ffmpeg from blocking
// when its pipe buffer fills; the consumer pulls frames at its own pace.

export class PcmQueue {
  private carry = Buffer.alloc(0);
  private frames: Uint8Array[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  totalBytes = 0;

  private firstByteResolve!: () => void;
  readonly firstByte: Promise<void>;

  constructor(private frameBytes: number) {
    this.firstByte = new Promise<void>((r) => (this.firstByteResolve = r));
  }

  /** Bytes waiting in whole frames (not yet pulled by the consumer). */
  get pendingBytes(): number {
    return this.frames.reduce((n, f) => n + f.length, 0);
  }
  /** Drops the oldest queued frames until at most maxBytes are waiting. Returns the dropped bytes. */
  trimTo(maxBytes: number): number {
    let dropped = 0;
    let pending = this.pendingBytes;
    while (pending > maxBytes && this.frames.length > 0) {
      const f = this.frames.shift() as Uint8Array;
      pending -= f.length;
      dropped += f.length;
    }
    return dropped;
  }
  push(chunk: Buffer): void {
    if (this.totalBytes === 0) this.firstByteResolve();
    this.totalBytes += chunk.length;
    this.carry = Buffer.concat([this.carry, chunk]);
    while (this.carry.length >= this.frameBytes) {
      this.frames.push(this.carry.subarray(0, this.frameBytes));
      this.carry = this.carry.subarray(this.frameBytes);
    }
    this.signal();
  }

  end(): void {
    if (this.carry.length > 0) {
      this.frames.push(this.carry);
      this.carry = Buffer.alloc(0);
    }
    this.ended = true;
    this.signal();
  }

  private signal(): void {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  async *frames$(): AsyncGenerator<Uint8Array> {
    while (true) {
      if (this.frames.length > 0) {
        yield this.frames.shift() as Uint8Array;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}
