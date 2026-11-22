// Offline replay of a Transcribe result stream through the Japanese segmenter (no AWS, fake clock) and the
// distribution report used to compare `simple` and `full`: chunks per reason, characters per chunk, share of chunks
// that end on a dangling token or have fewer than 6 characters.
import type { Chunk, TxResult } from "./segmenter.js";
import { JaSegmenter, type JaSegmenterOptions } from "./segmenter-ja.js";

export interface TimedResult {
  t: number; // wall ms at which the result arrives
  result: TxResult;
}
export interface JaReplay {
  chunks: Chunk[];
  reasons: Record<string, number>;
  report: string;
}

function pct(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function replayJa(stream: readonly TimedResult[], opts: JaSegmenterOptions, tickMs = 200): JaReplay {
  const chunks: Chunk[] = [];
  const seg = new JaSegmenter(opts, (c) => chunks.push(c));
  let now = stream.length > 0 ? stream[0].t : 0;
  for (const { t, result } of stream) {
    for (; now + tickMs <= t; now += tickMs) seg.tick(now + tickMs);
    now = t;
    seg.onResult(result, t);
  }
  const end = now + Math.max(opts.maxWaitMs, opts.mergeMaxHoldMs, 1000) + 1000;
  for (; now + tickMs <= end; now += tickMs) seg.tick(now + tickMs);
  seg.endOfStream("eof", end);
  const reasons: Record<string, number> = {};
  for (const c of chunks) reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
  const dangling = new Set(opts.danglingTokens);
  const lens = chunks.map((c) => c.words).sort((a, b) => a - b);
  const endsDangling = chunks.filter((c) => c.lastToken !== undefined && dangling.has(c.lastToken)).length;
  const short = chunks.filter((c) => c.words < 6).length;
  const n = chunks.length;
  const reasonText = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, k]) => `${r}=${k}`)
    .join(" ");
  const report =
    `mode=${opts.mode} chunks=${n} reasons: ${reasonText || "-"}\n` +
    `chars per chunk p50=${pct(lens, 50)} p90=${pct(lens, 90)} max=${lens[lens.length - 1] ?? 0}\n` +
    `ends on dangling token: ${n ? ((100 * endsDangling) / n).toFixed(1) : "0.0"}%  shorter than 6 chars: ${n ? ((100 * short) / n).toFixed(1) : "0.0"}%`;
  return { chunks, reasons, report };
}
