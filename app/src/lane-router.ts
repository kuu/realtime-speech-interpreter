// Fans every Transcribe result out to the gate of each lane. A failure in one lane's gate is logged with ch=<id> and
// never reaches the other lane (lane 2 must not delay or stop lane 1). Used only when a deploy has two lanes; a one-lane
// deploy hands the results to its gate directly, as before.
import { log } from "./log.js";
import type { ResultSink } from "./language-gate.js";
import type { TxResult } from "./segmenter.js";

export interface RoutedLane {
  id: string;
  sink: ResultSink;
  tick(now: number): void;
}

export class LaneRouter implements ResultSink {
  constructor(private readonly lanes: readonly RoutedLane[]) {}

  private each(what: string, fn: (l: RoutedLane) => void): void {
    for (const l of this.lanes) {
      try {
        fn(l);
      } catch (err) {
        log.error(`[router] ch=${l.id} ${what} error:`, err);
      }
    }
  }
  onResult(r: TxResult, now: number): void {
    this.each("result", (l) => l.sink.onResult(r, now));
  }
  endOfStream(reason: "eof" | "error", now: number): void {
    this.each("endOfStream", (l) => l.sink.endOfStream(reason, now));
  }
  tick(now: number): void {
    this.each("tick", (l) => l.tick(now));
  }
  get laneIds(): string[] {
    return this.lanes.map((l) => l.id);
  }
}
