// FROZEN PRE-MERGE COPY of segmenter.ts (before MERGE_SHORT was added). Used only by the
// off-switch parity tests in segmenter.test.ts (MERGE_SHORT=off must produce identical chunks).
// It contains no tests and is not listed in `npm test`; the .test.ts suffix keeps it out of dist/.
// Do not edit.
//
// Segmenter: turns Amazon Transcribe streaming results (partials with stabilization
// + finals) into translation chunks. Pure and synchronous: the clock is injected,
// there are no timers and no awaits, so it can't race with itself and it is unit-testable.
//
// Commit bookkeeping (no duplication / no loss by construction):
//   For every ResultId we keep `committed` = number of Items already moved into the
//   pending buffer. A partial commits items[committed .. stablePrefix) where
//   stablePrefix = count of leading items with Stable === true. A final commits
//   items[committed ..] and closes the result. Text is never sliced by characters.
//   End of stream / error commits the last partial's remainder (incl. unstable items).
//
// Cut rules (mode "clause"): sentence punctuation (any size); clause punctuation and
// conjunctions once >= minWords; hard cap at maxWords; time rules via tick():
// max time since chunk start (>= minWords) and pause (no transcript activity).
// Mode "sentence" (revert switch): sentence punctuation, pause, final, eof, 40-word cap.

import { log } from "./log.js";

export type SegmentationMode = "clause" | "sentence";

export interface SegmenterOptions {
  mode: SegmentationMode;
  minWords: number;
  maxWords: number;
  maxMs: number; // 0 disables
  pauseMs: number; // 0 disables
  conjunctions: readonly string[];
}

export type CutReason =
  | "sentence"
  | "comma"
  | "conj"
  | "max_words"
  | "max_time"
  | "pause"
  | "final"
  | "eof"
  | "error";

export interface Chunk {
  english: string;
  reason: CutReason;
  words: number;
  resultId: string; // result of the first token
  resultCounts: Record<string, number>; // tokens per result id in this chunk
  audioStart: number; // seconds (Transcribe stream time)
  audioEnd: number;
  committedAt: number; // wall ms
}

// Minimal structural types (compatible with @aws-sdk/client-transcribe-streaming).
export interface TxItem {
  Content?: string;
  Type?: string; // "pronunciation" | "punctuation"
  Stable?: boolean;
  StartTime?: number;
  EndTime?: number;
}
export interface TxResult {
  ResultId?: string;
  IsPartial?: boolean;
  Alternatives?: { Transcript?: string; Items?: TxItem[] }[];
}

interface Token {
  content: string;
  punct: boolean;
  filler: boolean;
  resultId: string;
  start: number;
  end: number;
  appendedAt: number;
}

interface ResultState {
  committed: number;
  contents: string[]; // contents of committed items, for change detection
  lastItems: TxItem[];
  sig: string;
  changedWarned: boolean;
}

const SENTENCE_END = new Set([".", "?", "!"]);
const CLAUSE_PUNCT = new Set([",", ";", ":"]);
const FILLERS = new Set(["um", "uh", "uhm", "erm", "er", "ah", "hmm", "hm", "mm", "mhm"]);
const SENTENCE_MODE_MAX_WORDS = 40;

function isPunctItem(it: TxItem): boolean {
  if (it.Type) return it.Type === "punctuation";
  return /^[^\p{L}\p{N}]+$/u.test(it.Content ?? "");
}

function countWords(tokens: readonly Token[]): number {
  let n = 0;
  for (const t of tokens) if (!t.punct && !t.filler) n++;
  return n;
}

// Words space-separated, punctuation attached to the previous word, leading punctuation dropped.
export function renderTokens(tokens: readonly { content: string; punct: boolean }[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.punct) {
      if (out) out += t.content;
    } else {
      out += (out ? " " : "") + t.content;
    }
  }
  return out.trim();
}

export class BaselineSegmenter {
  private results = new Map<string, ResultState>();
  private pending: Token[] = [];
  private lastActivityAt = 0;
  private conj: Set<string>;
  // Per-result record of every token consumed into a chunk (for the [verify] check).
  private emittedByResult = new Map<string, { content: string; punct: boolean }[]>();

  constructor(
    private readonly opts: SegmenterOptions,
    private readonly onChunk: (chunk: Chunk) => void,
  ) {
    this.conj = new Set(opts.conjunctions.map((c) => c.trim().toLowerCase()).filter(Boolean));
  }

  get pendingTokens(): number {
    return this.pending.length;
  }

  onResult(result: TxResult, now: number): void {
    const alt = result.Alternatives?.[0];
    if (!alt) return;
    const id = result.ResultId ?? "default";
    const items = (alt.Items ?? []).filter((it) => (it.Content ?? "") !== "");

    let st = this.results.get(id);
    if (!st) {
      st = { committed: 0, contents: [], lastItems: [], sig: "", changedWarned: false };
      this.results.set(id, st);
    }
    st.lastItems = items;

    // Activity = the hypothesis changed (new/changed words or stability). Used by the pause rule.
    const sig = items.map((it) => `${it.Content}${it.Stable ? "+" : "-"}`).join(" ");
    if (sig !== st.sig || !result.IsPartial) {
      st.sig = sig;
      this.lastActivityAt = now;
    }

    // Committed items must never change (Transcribe guarantees stable items don't).
    if (!st.changedWarned) {
      const n = Math.min(st.committed, items.length);
      for (let i = 0; i < n; i++) {
        if (items[i].Content !== st.contents[i]) {
          st.changedWarned = true;
          log.warn(
            `[segmenter] committed item changed result=${id} index=${i} ` +
              `committed="${st.contents[i]}" now="${items[i].Content}" (not re-emitted)`,
          );
          break;
        }
      }
    }

    if (result.IsPartial) {
      let stable = 0;
      while (stable < items.length && items[stable].Stable === true) stable++;
      if (stable > st.committed) this.commit(id, st, items.slice(st.committed, stable), now);
      this.runCuts(now);
    } else {
      if (items.length > st.committed) this.commit(id, st, items.slice(st.committed), now);
      this.results.delete(id);
      this.runCuts(now);
      this.flushAll("final", now);
      this.verify(id, items);
    }
  }

  // Time-based rules. Call periodically (e.g. every 200 ms).
  tick(now: number): void {
    if (this.pending.length === 0) return;
    const { mode, maxMs, pauseMs, minWords } = this.opts;
    if (
      mode === "clause" &&
      maxMs > 0 &&
      now - this.pending[0].appendedAt >= maxMs &&
      countWords(this.pending) >= minWords
    ) {
      this.flushAll("max_time", now);
      return;
    }
    if (pauseMs > 0 && now - this.lastActivityAt >= pauseMs) {
      this.flushAll("pause", now);
    }
  }

  // No more results are coming (input ended or Transcribe failed): commit everything
  // still open, including unstable items of the last partial, and flush.
  endOfStream(reason: "eof" | "error", now: number): void {
    for (const [id, st] of this.results) {
      if (st.lastItems.length > st.committed) {
        this.commit(id, st, st.lastItems.slice(st.committed), now);
      }
    }
    this.results.clear();
    this.runCuts(now);
    this.flushAll(reason, now);
    this.emittedByResult.clear();
  }

  private commit(id: string, st: ResultState, items: TxItem[], now: number): void {
    for (const it of items) {
      const content = it.Content as string;
      const punct = isPunctItem(it);
      this.pending.push({
        content,
        punct,
        filler: !punct && FILLERS.has(content.toLowerCase()),
        resultId: id,
        start: it.StartTime ?? 0,
        end: it.EndTime ?? 0,
        appendedAt: now,
      });
      st.contents.push(content);
    }
    st.committed += items.length;
  }

  // Apply the size/punctuation rules repeatedly; the earliest cut wins.
  private runCuts(now: number): void {
    for (;;) {
      const cut = this.findCut();
      if (!cut) return;
      this.emit(this.pending.splice(0, cut.end), cut.reason, now);
    }
  }

  private findCut(): { end: number; reason: CutReason } | null {
    const { mode, minWords, maxWords } = this.opts;
    const cap = mode === "clause" ? maxWords : SENTENCE_MODE_MAX_WORDS;
    let words = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) return { end: i + 1, reason: "sentence" };
        if (mode === "clause" && CLAUSE_PUNCT.has(t.content) && words >= minWords) {
          return { end: i + 1, reason: "comma" };
        }
        continue;
      }
      if (
        mode === "clause" &&
        !t.filler &&
        words >= minWords &&
        this.conj.has(t.content.toLowerCase())
      ) {
        return { end: i, reason: "conj" }; // the conjunction starts the next chunk
      }
      if (!t.filler) words++;
      if (words >= cap) {
        let end = i + 1;
        while (end < this.pending.length && this.pending[end].punct) end++;
        return { end, reason: "max_words" };
      }
    }
    return null;
  }

  private flushAll(reason: CutReason, now: number): void {
    if (this.pending.length === 0) return;
    this.emit(this.pending.splice(0), reason, now);
  }

  private emit(tokens: Token[], reason: CutReason, now: number): void {
    if (tokens.length === 0) return;
    const resultCounts: Record<string, number> = {};
    for (const t of tokens) {
      resultCounts[t.resultId] = (resultCounts[t.resultId] ?? 0) + 1;
      let rec = this.emittedByResult.get(t.resultId);
      if (!rec) this.emittedByResult.set(t.resultId, (rec = []));
      rec.push({ content: t.content, punct: t.punct });
    }
    const english = renderTokens(tokens);
    const words = tokens.filter((t) => !t.punct);
    if (!english || words.length === 0) {
      log.debug(`[segmenter] dropped punctuation-only chunk "${tokens.map((t) => t.content).join("")}"`);
      return;
    }
    this.onChunk({
      english,
      reason,
      words: countWords(tokens),
      resultId: tokens[0].resultId,
      resultCounts,
      audioStart: words[0].start,
      audioEnd: Math.max(...words.map((t) => t.end)),
      committedAt: now,
    });
  }

  // Compare everything consumed for this result with the final transcript items.
  private verify(id: string, finalItems: TxItem[]): void {
    const emitted = this.emittedByResult.get(id) ?? [];
    this.emittedByResult.delete(id);
    const finalTokens = finalItems.map((it) => ({ content: it.Content as string, punct: isPunctItem(it) }));
    const a = emitted.map((t) => t.content).join("\u0001");
    const b = finalTokens.map((t) => t.content).join("\u0001");
    if (a === b) {
      log.info(`[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length} OK final="${renderTokens(finalTokens)}"`);
    } else {
      log.warn(
        `[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length} MISMATCH ` +
          `committed="${renderTokens(emitted)}" final="${renderTokens(finalTokens)}"`,
      );
    }
  }
}
