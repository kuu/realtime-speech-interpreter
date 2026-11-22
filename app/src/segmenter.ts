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
//
// Merging short sentences (mergeShort, clause mode only): a sentence end (.?!) or a final
// that would produce a chunk with < sentenceMinWords words (fillers excluded) is not cut;
// the text is held at the front of `pending` (the boundary token is flagged heldBoundary)
// and joins the following text, across ResultIds. Internal periods stay in the text.
// Held text is released by: the next boundary once the combined text has >= sentenceMinWords;
// any comma/conjunction/max_words/max_time cut (they count from the start of pending);
// tick(): merge_pause (no transcript activity for mergePauseMs) or merge_hold (oldest held
// word older than mergeMaxHoldMs, safety valve); endOfStream (eof/error). While text is held,
// the regular pause rule is replaced by merge_pause. A period followed (in the same stable
// batch) by a lowercase word is treated as a false sentence end (no cut, no hold).
// Complete sentences are not held (sentenceCompleteWords > 0): a .?! that ends a sentence of
// >= sentenceCompleteWords words (counted from the previous .?!, fillers excluded; a final
// boundary inside the sentence does not restart the count) is cut at once with reason
// "sentence", together with any held fragment before it. Only fragments ("OK.", "I see.") merge.
// Words of the same sentence emitted earlier by a comma/conj/max_words/max_time cut count too
// (sentCarry), so the tail of a long sentence ("… existing services.") is not held either.
// Held tokens are ordinary pending tokens, so they are emitted exactly once by splice.
// With mergeShort off (or in sentence mode) every merge branch is skipped.

import { log } from "./log.js";

export type SegmentationMode = "clause" | "sentence";

export interface SegmenterOptions {
  mode: SegmentationMode;
  minWords: number;
  maxWords: number;
  maxMs: number; // 0 disables
  pauseMs: number; // 0 disables
  conjunctions: readonly string[];
  mergeShort: boolean; // clause mode only
  sentenceMinWords: number; // sentence/final cuts below this are held (merge on)
  mergePauseMs: number; // release held text after this much transcript silence; 0 disables
  mergeMaxHoldMs: number; // release held text once its oldest word is this old (always applies)
  // Merge on: a .?! ending a sentence of >= this many words is cut even when the chunk is
  // short (a complete sentence is never held). 0/absent disables (pre-existing behavior).
  sentenceCompleteWords?: number;
  // --- quality-v1 part B. All optional; absent / 0 / false = the pre-existing behavior exactly. ---
  // B1 dangling-end guard: do not end a chunk on a word that cannot end a thought (preposition,
  // article, relative pronoun, conjunction, auxiliary: see DEFAULT_DANGLING_WORDS).
  //   comma / conj / max_words cuts skip such a position (max_words may run danglingMaxWords over);
  //   time / final cuts are deferred for at most danglingMaxHoldMs (eof and .?! never defer).
  danglingGuard?: boolean;
  danglingWords?: readonly string[]; // empty/absent = DEFAULT_DANGLING_WORDS
  danglingMaxWords?: number; // extra words allowed past maxWords while the last word dangles
  danglingMaxHoldMs?: number; // upper bound for deferring a time/final cut on a dangling tail
  // B2 look-ahead: a pause/final cut whose tail has no sentence end waits this long for more text. 0 = off.
  cutLookaheadMs?: number;
  // B2 variant: hold any final that ends mid-sentence like a short remainder (merge on only).
  finalHold?: boolean;
  // B3 short-sentence join: while only tiny fragments (<= shortSentenceWords words each) are held, the
  // merge pause is shortJoinPauseMs (0 = mergePauseMs), and short sentences inside one chunk are
  // comma-joined in the rendered English ("There's small, Medium, and large.").
  shortSentenceJoin?: boolean;
  shortSentenceWords?: number;
  shortJoinPauseMs?: number;
}

export type CutReason =
  | "sentence"
  | "comma"
  | "conj"
  | "max_words"
  | "max_time"
  | "pause"
  // Japanese segmenter (segmenter-ja.ts): stable 、, wait limit, character limit, clause ending.
  | "clause"
  | "maxwait"
  | "maxchars"
  | "ending"
  | "merge_pause"
  | "merge_hold"
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
  merged?: number; // merge on only: number of held (suppressed) boundaries inside this chunk; absent if 0
  lastToken?: string; // Japanese segmenter only: the last non-punctuation item of the chunk (for the dangling-end report)
}

// Minimal structural types (compatible with @aws-sdk/client-transcribe-streaming).
export interface TxItem {
  Content?: string;
  Type?: string; // "pronunciation" | "punctuation"
  Stable?: boolean;
  StartTime?: number;
  EndTime?: number;
  Confidence?: number; // finals only
}
export interface TxResult {
  ResultId?: string;
  IsPartial?: boolean;
  StartTime?: number;
  EndTime?: number;
  LanguageCode?: string; // multi-language identification only
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
  heldBoundary?: boolean; // merge: a sentence/final cut was suppressed after this token
  verified?: boolean; // merge: already counted by [verify] for its (closed) result
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

// Words a chunk should not end on (lower-case). Matched against the last non-filler word.
export const DEFAULT_DANGLING_WORDS: readonly string[] = [
  // prepositions
  "in", "on", "at", "to", "of", "for", "with", "within", "from", "into", "by", "about", "over", "under",
  "through", "across", "between", "among", "during", "via", "per", "than", "as",
  // determiners
  "a", "an", "the", "this", "that", "these", "those", "each", "every", "my", "your", "our", "their", "its",
  "his", "her", "some", "any", "no",
  // relative pronouns / subordinators
  "who", "whom", "whose", "which", "where", "when", "while", "if", "because", "although", "though",
  "unless", "since", "until",
  // conjunctions
  "and", "or", "but", "so", "nor",
  // auxiliaries / modals
  "is", "are", "was", "were", "am", "can", "will", "would", "should", "could", "may", "might", "must",
  "have", "has", "had", "been", "be", "being", "do", "does", "did", "'s", "'re", "'ve", "'ll", "'d", "not",
];

// Apostrophe forms: "you're", "we've", "I'll", "he'd", "I'm" and possessive/be "'s" ("Alex's")
// dangle; "that's" does not.
function isDanglingWord(word: string, set: ReadonlySet<string>): boolean {
  const w = word.toLowerCase().replace(/\u2019/g, "'");
  if (set.has(w)) return true;
  if (/[a-z0-9]'(re|ve|ll|d|m)$/.test(w)) return true;
  return /[a-z0-9]'s$/.test(w) && w !== "that's";
}

// Render-only join of tiny sentences inside one chunk: `There's small. Medium? And large.`
// -> `There's small, Medium, and large.` A .?! becomes "," when the segment before and the segment
// after it each have 1..maxWords words (fillers excluded) and text follows it in the chunk. The first
// letter of a following and/or/but/so is lower-cased. Never used for the tokens [verify] checks.
export function joinShortSentences(
  tokens: readonly { content: string; punct: boolean; filler?: boolean }[],
  maxWords: number,
): string {
  const isFiller = (t: { content: string; punct: boolean; filler?: boolean }) =>
    t.filler ?? (!t.punct && FILLERS.has(t.content.toLowerCase()));
  const segWords: number[] = [0]; // words per segment, segments split at .?!
  const endIdx: number[] = []; // index of each .?! token; endIdx[k] separates segment k and k+1
  tokens.forEach((t, i) => {
    if (t.punct && SENTENCE_END.has(t.content)) {
      endIdx.push(i);
      segWords.push(0);
    } else if (!t.punct && !isFiller(t)) segWords[segWords.length - 1]++;
  });
  const out: { content: string; punct: boolean }[] = [];
  const joined = new Set<number>(); // token index of a .?! turned into ","
  endIdx.forEach((i, k) => {
    const before = segWords[k], after = segWords[k + 1];
    if (before >= 1 && before <= maxWords && after >= 1 && after <= maxWords) joined.add(i);
  });
  let lowerNext = false;
  tokens.forEach((t, i) => {
    if (joined.has(i)) {
      out.push({ content: ",", punct: true });
      lowerNext = true;
      return;
    }
    if (lowerNext && !t.punct && !isFiller(t)) {
      lowerNext = false;
      const lc = t.content.toLowerCase();
      if (lc === "and" || lc === "or" || lc === "but" || lc === "so") {
        out.push({ content: t.content.charAt(0).toLowerCase() + t.content.slice(1), punct: false });
        return;
      }
    }
    out.push({ content: t.content, punct: t.punct });
  });
  return renderTokens(out);
}

export function isPunctItem(it: TxItem): boolean {
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

// Optional observer of the words the segmenter consumes (live captions). Called exactly once per
// token, at the single point where tokens move into `pending`. Errors are swallowed: a caption
// bug must never affect segmentation.
export interface SegmenterTap {
  onWords(batch: {
    resultId: string;
    tokens: { content: string; punct: boolean; filler: boolean }[];
    audioStart: number;
    audioEnd: number;
    now: number;
  }): void;
  // The result was forwarded and later turned out to be another language (late flip).
  onRetract(resultId: string): void;
}

export class Segmenter {
  private results = new Map<string, ResultState>();
  private pending: Token[] = [];
  private lastActivityAt = 0;
  private conj: Set<string>;
  // Per-result record of every token consumed into a chunk (for the [verify] check).
  private emittedByResult = new Map<string, { content: string; punct: boolean }[]>();
  private readonly merge: boolean;
  // Complete-sentence release: words of the current sentence already emitted in earlier chunks
  // (the sentence was cut mid-way by a comma/conjunction/max_words/max_time rule), so the
  // sentence's tail ("… with the existing services.") counts as the end of a complete sentence.
  private sentCarry = 0;
  // B1/B2: a time/final cut is being deferred until deferUntil (wall ms), then flushed with deferReason.
  private deferUntil: number | null = null;
  private deferReason: CutReason = "pause";
  private readonly danglingSet: ReadonlySet<string>;

  constructor(
    private readonly opts: SegmenterOptions,
    private readonly onChunk: (chunk: Chunk) => void,
    private readonly tap?: SegmenterTap,
  ) {
    this.conj = new Set(opts.conjunctions.map((c) => c.trim().toLowerCase()).filter(Boolean));
    this.merge = opts.mergeShort && opts.mode === "clause";
    const dw = opts.danglingWords && opts.danglingWords.length > 0 ? opts.danglingWords : DEFAULT_DANGLING_WORDS;
    this.danglingSet = new Set(dw.map((w) => w.trim().toLowerCase()).filter(Boolean));
  }

  get pendingTokens(): number {
    return this.pending.length;
  }

  // How long the oldest held word has been waiting (0 when nothing is held).
  holdAgeMs(now: number): number {
    return this.merge && this.holdEnd() > 0 ? now - this.pending[0].appendedAt : 0;
  }

  // 1 + index of the last held boundary in pending, or 0 when nothing is held.
  // Held tokens are always a prefix of pending (cuts only remove prefixes).
  private holdEnd(): number {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].heldBoundary) return i + 1;
    return 0;
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
      this.finalCut(now);
      this.verify(id, items);
    }
  }

  // End of a final result: flush, or (merge on) hold a short remainder for the next result.
  private finalCut(now: number): void {
    if (
      this.merge &&
      this.pending.some((t) => !t.punct) &&
      countWords(this.pending) < this.opts.sentenceMinWords
    ) {
      this.pending[this.pending.length - 1].heldBoundary = true;
      return;
    }
    if (this.merge && this.opts.finalHold && this.pending.some((t) => !t.punct) && !this.tailSentenceEnd()) {
      this.pending[this.pending.length - 1].heldBoundary = true; // B2 variant: hold any mid-sentence final
      return;
    }
    this.flushOrDefer("final", now);
  }

  // B1/B2: flush `reason` now, or defer it (bounded) when the chunk ends on a dangling word or, for
  // pause/final, mid-sentence with a look-ahead configured. With every switch off this is flushAll.
  private flushOrDefer(reason: CutReason, now: number): void {
    if (this.pending.length === 0) return;
    if (this.deferUntil !== null) {
      if (now >= this.deferUntil) this.flushAll(this.deferReason, now);
      return;
    }
    let limit = 0;
    if (this.opts.danglingGuard && (this.opts.danglingMaxHoldMs ?? 0) > 0 && this.tailDangling()) {
      limit = this.opts.danglingMaxHoldMs as number;
    } else if (
      (this.opts.cutLookaheadMs ?? 0) > 0 &&
      (reason === "pause" || reason === "final") &&
      !this.tailSentenceEnd()
    ) {
      limit = this.opts.cutLookaheadMs as number;
    }
    if (limit > 0) {
      this.deferUntil = now + limit;
      this.deferReason = reason;
      log.debug(`[segmenter] defer ${reason} ${limit}ms tail="${renderTokens(this.pending.slice(-6))}"`);
      return;
    }
    this.flushAll(reason, now);
  }

  // Last non-filler word of pending (clause punctuation skipped); false when a .?! comes first.
  private tailDangling(): boolean {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) return false;
        continue;
      }
      if (t.filler) continue;
      return isDanglingWord(t.content, this.danglingSet);
    }
    return false;
  }

  // True when pending ends with .?! (fillers and clause punctuation after it ignored).
  private tailSentenceEnd(): boolean {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) return true;
        continue;
      }
      if (!t.filler) return false;
    }
    return false;
  }

  // B3: true when every held sentence segment (split at .?! inside the held prefix) has
  // <= shortSentenceWords words, i.e. only tiny fragments are held.
  private heldOnlyShort(holdEnd: number): boolean {
    const limit = this.opts.shortSentenceWords ?? 3;
    let n = 0;
    for (let i = 0; i < holdEnd; i++) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) {
          if (n > limit) return false;
          n = 0;
        }
      } else if (!t.filler) n++;
    }
    return n <= limit;
  }

  // Time-based rules. Call periodically (e.g. every 200 ms).
  tick(now: number): void {
    if (this.pending.length === 0) return;
    const { mode, maxMs, pauseMs, minWords } = this.opts;
    if (this.deferUntil !== null && now >= this.deferUntil) {
      this.flushAll(this.deferReason, now);
      return;
    }
    if (
      mode === "clause" &&
      maxMs > 0 &&
      now - this.pending[0].appendedAt >= maxMs &&
      countWords(this.pending) >= minWords
    ) {
      this.flushOrDefer("max_time", now);
      return;
    }
    if (this.merge && this.holdEnd() > 0) {
      // Held text: the merge rules replace the regular pause rule. The hold valve always
      // applies (it can't be disabled), so held text can never stall output.
      const { mergeMaxHoldMs } = this.opts;
      let mergePauseMs = this.opts.mergePauseMs;
      if (this.opts.shortSentenceJoin && (this.opts.shortJoinPauseMs ?? 0) > 0 && this.heldOnlyShort(this.holdEnd())) {
        mergePauseMs = this.opts.shortJoinPauseMs as number; // B3: tiny fragments wait longer
      }
      if (now - this.pending[0].appendedAt >= mergeMaxHoldMs) {
        this.flushOrDefer("merge_hold", now);
      } else if (mergePauseMs > 0 && now - this.lastActivityAt >= mergePauseMs) {
        this.flushOrDefer("merge_pause", now);
      }
      return;
    }
    if (pauseMs > 0 && now - this.lastActivityAt >= pauseMs) {
      this.flushOrDefer("pause", now);
    }
  }

  // Transcript activity that is not forwarded as a result (language gate: a source-language
  // result still settling). Keeps the pause / merge_pause timers as if the words were seen.
  noteActivity(now: number): void {
    this.lastActivityAt = now;
  }

  // Language gate: an already-forwarded result turned out to be another language (late flip).
  // Removes its not-yet-emitted tokens from pending and closes it without a MISMATCH.
  // Returns how many of its tokens were already emitted (spoken or queued) and how many were removed.
  closeResult(id: string, lang: string, now: number): { emitted: number; removed: number } {
    if (!this.results.has(id)) return { emitted: 0, removed: 0 };
    this.results.delete(id);
    try {
      this.tap?.onRetract(id);
    } catch (err) {
      log.warn(`[segmenter] tap error: ${String(err)}`);
    }
    const before = this.pending.length;
    this.pending = this.pending.filter((t) => t.resultId !== id);
    const removed = before - this.pending.length;
    const emitted = this.emittedByResult.get(id)?.length ?? 0;
    this.emittedByResult.delete(id);
    log.warn(
      `[verify] result=${id.slice(0, 8)} committed=${emitted + removed} emitted=${emitted} removed=${removed} ` +
        `LANGDROP lang=${lang} (language switched after commit)`,
    );
    this.runCuts(now);
    return { emitted, removed };
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
    this.deferUntil = null; // new text: the normal rules decide again
    const tapTokens: { content: string; punct: boolean; filler: boolean }[] = [];
    let tapStart = Infinity;
    let tapEnd = 0;
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
      if (this.tap) {
        const last = this.pending[this.pending.length - 1];
        tapTokens.push({ content, punct, filler: last.filler });
        tapStart = Math.min(tapStart, last.start);
        tapEnd = Math.max(tapEnd, last.end);
      }
      st.contents.push(content);
    }
    st.committed += items.length;
    if (this.tap && tapTokens.length > 0) {
      try {
        this.tap.onWords({
          resultId: id,
          tokens: tapTokens,
          audioStart: Number.isFinite(tapStart) ? tapStart : 0,
          audioEnd: tapEnd,
          now,
        });
      } catch (err) {
        log.warn(`[segmenter] tap error: ${String(err)}`);
      }
    }
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
    // Words of the current sentence only (since the last .?! in pending). A final-held
    // boundary does not reset it: Transcribe splits results mid-sentence.
    let sentWords = this.sentCarry;
    const guard = !!this.opts.danglingGuard && mode === "clause";
    let lastWord = ""; // last non-filler word seen (B1)
    const dangles = () => guard && lastWord !== "" && isDanglingWord(lastWord, this.danglingSet);
    for (let i = 0; i < this.pending.length; i++) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) {
          if (this.merge) {
            // Period followed by a lowercase word: likely a false sentence end.
            const next = this.pending[i + 1];
            const falseEnd = !!next && !next.punct && /^\p{Ll}/u.test(next.content);
            if (words < this.opts.sentenceMinWords) {
              // Short chunk: hold (keep the period in the text and keep scanning), unless
              // this sentence by itself is complete (>= sentenceCompleteWords words).
              const cw = this.opts.sentenceCompleteWords ?? 0;
              const complete = cw > 0 && sentWords >= cw && !falseEnd;
              if (!complete) {
                t.heldBoundary = true;
                sentWords = 0;
                continue;
              }
            } else if (falseEnd) {
              sentWords = 0;
              continue;
            }
          }
          return { end: i + 1, reason: "sentence" };
        }
        if (mode === "clause" && CLAUSE_PUNCT.has(t.content) && words >= minWords && !dangles()) {
          return { end: i + 1, reason: "comma" };
        }
        continue;
      }
      if (
        mode === "clause" &&
        !t.filler &&
        words >= minWords &&
        this.conj.has(t.content.toLowerCase()) &&
        !dangles()
      ) {
        return { end: i, reason: "conj" }; // the conjunction starts the next chunk
      }
      if (!t.filler) {
        words++;
        sentWords++;
        lastWord = t.content;
      }
      // B1: past the cap, keep going (up to danglingMaxWords extra words) while the last word dangles.
      if (words >= cap && !(dangles() && words < cap + (this.opts.danglingMaxWords ?? 0))) {
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
    this.deferUntil = null;
    this.updateSentCarry(tokens, reason);
    const resultCounts: Record<string, number> = {};
    let merged = 0;
    for (const t of tokens) {
      resultCounts[t.resultId] = (resultCounts[t.resultId] ?? 0) + 1;
      if (t.heldBoundary) merged++;
      if (t.verified) continue; // its result was already verified while this token was held
      let rec = this.emittedByResult.get(t.resultId);
      if (!rec) this.emittedByResult.set(t.resultId, (rec = []));
      rec.push({ content: t.content, punct: t.punct });
    }
    const english = this.opts.shortSentenceJoin
      ? joinShortSentences(tokens, this.opts.shortSentenceWords ?? 3)
      : renderTokens(tokens);
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
      ...(merged > 0 ? { merged } : {}),
    });
  }

  // A chunk cut mid-sentence (comma/conj/max_words/max_time, a Transcribe final split inside the
  // sentence, or the plain pause rule) carries its sentence's word count into the next chunk.
  // A hold release (merge_pause, merge_hold) or end of stream starts fresh: that text was a
  // fragment followed by silence, and a 1-2 word remainder after it ("Michael.") would otherwise
  // come out as a fragment of its own.
  private updateSentCarry(tokens: readonly Token[], reason: CutReason): void {
    if (!this.merge || !(this.opts.sentenceCompleteWords ?? 0)) return;
    if (reason !== "comma" && reason !== "conj" && reason !== "max_words" && reason !== "max_time" && reason !== "final" && reason !== "pause") {
      this.sentCarry = 0;
      return;
    }
    let n = this.sentCarry;
    for (const t of tokens) {
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) n = 0;
      } else if (!t.filler) n++;
    }
    this.sentCarry = n;
  }

  // Compare everything consumed for this result with the final transcript items.
  // Tokens of this result still held in pending (merge on) count as committed; they are
  // marked verified so emit() doesn't record them again for a result that is already closed.
  private verify(id: string, finalItems: TxItem[]): void {
    const emitted = [...(this.emittedByResult.get(id) ?? [])];
    this.emittedByResult.delete(id);
    let held = 0;
    for (const t of this.pending) {
      if (t.resultId !== id || t.verified) continue;
      t.verified = true;
      emitted.push({ content: t.content, punct: t.punct });
      held++;
    }
    const heldStr = held > 0 ? ` held=${held}` : "";
    const finalTokens = finalItems.map((it) => ({ content: it.Content as string, punct: isPunctItem(it) }));
    const a = emitted.map((t) => t.content).join("\u0001");
    const b = finalTokens.map((t) => t.content).join("\u0001");
    if (a === b) {
      log.info(`[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length}${heldStr} OK final="${renderTokens(finalTokens)}"`);
    } else {
      log.warn(
        `[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length}${heldStr} MISMATCH ` +
          `committed="${renderTokens(emitted)}" final="${renderTokens(finalTokens)}"`,
      );
    }
  }
}
