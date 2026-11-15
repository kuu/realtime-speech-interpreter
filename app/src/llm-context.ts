// Ring buffer of the last N chunks that were actually committed to playback: the exact English sent
// to the engine and the exact Japanese handed to Polly. Pure.
import type { PreviousItem } from "./llm-prompt.js";

export interface ContextEntry extends PreviousItem {
  session: number;
  srcEndWall: number; // wall ms of the chunk's last English word (source time)
}

export class ContextBuffer {
  private items: ContextEntry[] = [];

  // capacity 0 disables context; resetMs 0 = never reset on silence.
  constructor(
    private readonly capacity: number,
    private readonly resetMs: number,
  ) {}

  // Call before building a request. Clears when the session changed or the source-time gap since
  // the last pushed chunk is >= resetMs. Returns the previous items, oldest first.
  prepare(session: number, srcStartWall: number): PreviousItem[] {
    const last = this.items[this.items.length - 1];
    if (last && (last.session !== session || (this.resetMs > 0 && srcStartWall - last.srcEndWall >= this.resetMs))) {
      this.items = [];
    }
    return this.items.map(({ en, ja }) => ({ en, ja }));
  }

  // Call when a chunk is committed to playback (after synthesize succeeded).
  push(e: ContextEntry): void {
    if (this.capacity <= 0) return;
    this.items.push(e);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  get size(): number {
    return this.items.length;
  }
}
