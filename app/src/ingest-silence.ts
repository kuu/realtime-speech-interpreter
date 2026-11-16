// Level measurement for the browser input: RMS in dBFS per frame, and how long the real audio has stayed
// below the silence threshold. Pure.
const FLOOR_DB = -120;
/** RMS level of s16le mono PCM in dBFS (-120 for digital silence). */
export function frameRmsDb(pcm: Uint8Array): number {
  const n = pcm.length >> 1;
  if (n === 0) return FLOOR_DB;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = dv.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  const db = 10 * Math.log10(sum / n);
  return Number.isFinite(db) ? Math.max(FLOOR_DB, db) : FLOOR_DB;
}
export class LevelTracker {
  rmsDb = FLOOR_DB;
  silentMs = 0;
  constructor(private readonly thresholdDb: number) {}
  observe(pcm: Uint8Array, durationMs: number): void {
    this.rmsDb = frameRmsDb(pcm);
    if (this.rmsDb < this.thresholdDb) this.silentMs += durationMs;
    else this.silentMs = 0;
  }
  reset(): void {
    this.rmsDb = FLOOR_DB;
    this.silentMs = 0;
  }
}
