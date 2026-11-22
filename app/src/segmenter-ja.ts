// Japanese segmenter: turns the stable Japanese transcript of a ja-JP source lane into translation chunks. Same public
// surface as Segmenter (onResult, noteActivity, tick, closeResult, endOfStream, caption tap); the English Segmenter is
// not touched. Pure and synchronous, clock injected.
//
// Japanese has no spaces and the verb comes last, so the unit is the character and an early cut costs quality. Only
// STABLE items are committed (Transcribe never changed a stable item), so every cut sits on stable text.
//
// mode "simple" (default): cut at a stable 。？！, at every stable 、, after maxWaitMs, and on the final.
//   Reasons: sentence, clause, maxwait, final (eof/error at the end of the stream).
// mode "full" (opt-in experiment, JA_SEGMENTATION_MODE=full): the fuller rule set of docs/bilingual-channels.md:
//   1 sentence end (merge-short when mergeShort is on), 2 clause end (min clauseMinChars, dangling test D),
//   3 clause-closing ending after a quiet pauseMs, 4 maxChars, 5 pause (D), 6 maxWait, 7 final.
//   Reasons also: ending, maxchars, pause.
// 「 and 」 are not cut points; a 」 right after a cut point stays with the chunk it closes.
import type { config as GlobalConfig } from "./config.js";
import { log } from "./log.js";
import { isPunctItem, type Chunk, type CutReason, type SegmenterTap, type TxItem, type TxResult } from "./segmenter.js";

export type JaSegmentationMode = "simple" | "full";

export interface JaSegmenterOptions {
  mode: JaSegmentationMode;
  maxWaitMs: number; // oldest uncut stable character older than this is cut (0 disables)
  // merge-short (both modes, only when mergeShort is on): a sentence shorter than sentenceMinChars is held and joined
  // with the next one, released after mergePauseMs of silence or mergeMaxHoldMs.
  mergeShort: boolean;
  sentenceMinChars: number;
  mergePauseMs: number;
  mergeMaxHoldMs: number;
  // full mode only
  clauseMinChars: number;
  maxChars: number;
  pauseMs: number;
  clauseEndings: readonly string[];
  danglingTokens: readonly string[];
  danglingMaxChars: number;
  // Source-side filler removal (config fillers.jaPatterns; empty = off).
  fillerPatterns?: readonly string[];
}

export { JA_DEFAULT_CLAUSE_ENDINGS, JA_DEFAULT_DANGLING_TOKENS, jaListOverlap } from "./ja-defaults.js";

const SENTENCE_END = new Set(["。", "？", "！", "?", "!"]);
const CLOSE_QUOTE = "」";
const COMMA = "、";
const LATIN = /[A-Za-z0-9]/;

interface Token {
  content: string;
  punct: boolean;
  resultId: string;
  start: number;
  end: number;
  appendedAt: number;
  heldBoundary?: boolean;
  verified?: boolean;
}
interface ResultState {
  committed: number;
  contents: string[];
  lastItems: TxItem[];
  sig: string;
  changedWarned: boolean;
}

const charLen = (s: string): number => [...s].length;
function charCount(tokens: readonly Token[]): number {
  let n = 0;
  for (const t of tokens) if (!t.punct) n += charLen(t.content);
  return n;
}
// Japanese is joined as written; two Latin/digit neighbours (Amazon Bedrock) keep a space.
export function joinJapanese(tokens: readonly { content: string; punct: boolean }[]): string {
  let out = "";
  for (const t of tokens) {
    if (out && !t.punct && LATIN.test(out[out.length - 1]) && LATIN.test(t.content[0] ?? "")) out += " ";
    out += t.content;
  }
  return out.trim();
}

export class JaSegmenter {
  private results = new Map<string, ResultState>();
  private pending: Token[] = [];
  private lastActivityAt = 0;
  private emittedByResult = new Map<string, { content: string; punct: boolean }[]>();
  private readonly dangling: ReadonlySet<string>;
  private readonly fillers: ReadonlySet<string>; // filler words without the trailing 、
  private readonly sentenceStartFillers: ReadonlySet<string>; // patterns ending in 、 (sentence start only)
  private atSentenceStart = true; // the next chunk starts a sentence
  readonly reasons: Partial<Record<CutReason, number>> = {};

  constructor(
    private readonly opts: JaSegmenterOptions,
    private readonly onChunk: (chunk: Chunk) => void,
    private readonly tap?: SegmenterTap,
  ) {
    this.dangling = new Set(opts.danglingTokens.map((w) => w.trim()).filter(Boolean));
    const pats = (opts.fillerPatterns ?? []).map((p) => p.trim()).filter(Boolean);
    this.fillers = new Set(pats.filter((p) => !p.endsWith(COMMA)));
    this.sentenceStartFillers = new Set(pats.filter((p) => p.endsWith(COMMA)).map((p) => p.slice(0, -1)));
  }

  private get merge(): boolean {
    return this.opts.mergeShort;
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
    const sig = items.map((it) => `${it.Content}${it.Stable ? "+" : "-"}`).join(" ");
    if (sig !== st.sig || !result.IsPartial) {
      st.sig = sig;
      this.lastActivityAt = now;
    }
    if (!st.changedWarned) {
      const n = Math.min(st.committed, items.length);
      for (let i = 0; i < n; i++) {
        if (items[i].Content !== st.contents[i]) {
          st.changedWarned = true;
          log.warn(
            `[segmenter-ja] committed item changed result=${id} index=${i} committed="${st.contents[i]}" now="${items[i].Content}" (not re-emitted)`,
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

  noteActivity(now: number): void {
    this.lastActivityAt = now;
  }

  // Language gate: an already-forwarded result turned out to be another language (late flip).
  closeResult(id: string, lang: string, now: number): { emitted: number; removed: number } {
    if (!this.results.has(id)) return { emitted: 0, removed: 0 };
    this.results.delete(id);
    try {
      this.tap?.onRetract(id);
    } catch (err) {
      log.warn(`[segmenter-ja] tap error: ${String(err)}`);
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

  endOfStream(reason: "eof" | "error", now: number): void {
    for (const [id, st] of this.results) {
      if (st.lastItems.length > st.committed) this.commit(id, st, st.lastItems.slice(st.committed), now);
    }
    this.results.clear();
    this.runCuts(now);
    this.flushAll(reason, now);
    this.emittedByResult.clear();
  }

  // Time-based rules; call periodically (every 200 ms).
  tick(now: number): void {
    if (this.pending.length === 0) return;
    const o = this.opts;
    const first = this.pending.find((t) => !t.punct);
    if (!first) return;
    if (o.maxWaitMs > 0 && now - first.appendedAt >= o.maxWaitMs) {
      if (o.mode === "full") this.emit(this.pending.splice(0, this.chooseCut(this.pending.length)), "maxwait", now);
      else this.flushAll("maxwait", now);
      this.runCuts(now);
      return;
    }
    if (this.heldEnd() > 0) {
      if (o.mergeMaxHoldMs > 0 && now - first.appendedAt >= o.mergeMaxHoldMs) this.flushAll("merge_hold", now);
      else if (o.mergePauseMs > 0 && now - this.lastActivityAt >= o.mergePauseMs) this.flushAll("merge_pause", now);
      return;
    }
    if (o.mode !== "full" || o.pauseMs <= 0 || now - this.lastActivityAt < o.pauseMs) return;
    const chars = charCount(this.pending);
    if (chars >= o.clauseMinChars && this.endsWithClauseEnding(this.pending.length)) {
      this.flushAll("ending", now);
      return;
    }
    if (!this.isDangling(this.pending.length)) this.flushAll("pause", now);
    // else: the hold ends with new text (re-tested) or with maxWait
  }

  // ---- internals ----

  private heldEnd(): number {
    if (!this.merge) return 0;
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].heldBoundary) return i + 1;
    return 0;
  }

  private commit(id: string, st: ResultState, items: TxItem[], now: number): void {
    const tapTokens: { content: string; punct: boolean; filler: boolean }[] = [];
    let tapStart = Infinity;
    let tapEnd = 0;
    for (const it of items) {
      const content = it.Content as string;
      const punct = isPunctItem(it);
      this.pending.push({ content, punct, resultId: id, start: it.StartTime ?? 0, end: it.EndTime ?? 0, appendedAt: now });
      const last = this.pending[this.pending.length - 1];
      if (this.tap) {
        tapTokens.push({ content, punct, filler: false });
        tapStart = Math.min(tapStart, last.start);
        tapEnd = Math.max(tapEnd, last.end);
      }
      st.contents.push(content);
    }
    st.committed += items.length;
    if (this.tap && tapTokens.length > 0) {
      try {
        this.tap.onWords({ resultId: id, tokens: tapTokens, audioStart: Number.isFinite(tapStart) ? tapStart : 0, audioEnd: tapEnd, now });
      } catch (err) {
        log.warn(`[segmenter-ja] tap error: ${String(err)}`);
      }
    }
  }

  private runCuts(now: number): void {
    for (;;) {
      const cut = this.findCut();
      if (!cut) return;
      this.emit(this.pending.splice(0, cut.end), cut.reason, now);
    }
  }

  // End of a final result: flush, or (merge-short) hold a short remainder for the next result.
  private finalCut(now: number): void {
    if (this.merge && this.pending.some((t) => !t.punct) && charCount(this.pending) < this.opts.sentenceMinChars) {
      this.pending[this.pending.length - 1].heldBoundary = true;
      return;
    }
    this.flushAll("final", now);
  }

  // A closing quote right after a cut point belongs to the chunk it closes.
  private withQuote(end: number): number {
    let e = end;
    while (e < this.pending.length && this.pending[e].content === CLOSE_QUOTE) e++;
    return e;
  }

  private findCut(): { end: number; reason: CutReason } | null {
    const o = this.opts;
    let chars = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const t = this.pending[i];
      if (t.punct) {
        if (SENTENCE_END.has(t.content)) {
          if (this.merge && chars < o.sentenceMinChars) {
            t.heldBoundary = true;
            continue;
          }
          return { end: this.withQuote(i + 1), reason: "sentence" };
        }
        if (t.content === COMMA) {
          if (o.mode === "simple") return { end: this.withQuote(i + 1), reason: "clause" };
          if (chars >= o.clauseMinChars && !this.isDangling(i + 1)) return { end: this.withQuote(i + 1), reason: "clause" };
        }
        continue;
      }
      chars += charLen(t.content);
      if (o.mode === "full" && o.maxChars > 0 && chars >= o.maxChars) {
        return { end: this.chooseCut(i + 1), reason: "maxchars" };
      }
    }
    return null;
  }

  // Dangling test D: the last token before pending[end), ignoring trailing punctuation, is a dangling token.
  private isDangling(end: number): boolean {
    for (let i = Math.min(end, this.pending.length) - 1; i >= 0; i--) {
      const t = this.pending[i];
      if (t.punct) continue;
      return this.dangling.has(t.content);
    }
    return false;
  }
  private endsWithClauseEnding(end: number): boolean {
    const text = this.pending.slice(0, end).filter((t) => !t.punct).map((t) => t.content).join("");
    return this.opts.clauseEndings.some((e) => e !== "" && text.endsWith(e));
  }
  // Rules 4 and 6: where to cut a long buffer ending at limitEnd. Last stable 、 with D false, else the last clause
  // ending, else the last token boundary with D false, each at most danglingMaxChars before the end; else the end.
  // Returns the number of tokens to cut (always >= 1).
  private chooseCut(limitEnd: number): number {
    const back = this.opts.danglingMaxChars;
    const tail = (b: number) => charCount(this.pending.slice(b, limitEnd));
    const done = (b: number) => {
      let e = b;
      while (e < limitEnd && this.pending[e].punct && !SENTENCE_END.has(this.pending[e].content)) e++;
      return Math.max(1, this.withQuote(e));
    };
    for (let b = limitEnd; b >= 1 && tail(b) <= back; b--) {
      if (this.pending[b - 1].content === COMMA && !this.isDangling(b)) return done(b);
    }
    for (let b = limitEnd; b >= 1 && tail(b) <= back; b--) {
      if (!this.pending[b - 1].punct && this.endsWithClauseEnding(b)) return done(b);
    }
    for (let b = limitEnd; b >= 1 && tail(b) <= back; b--) {
      if (!this.isDangling(b)) return done(b);
    }
    return limitEnd;
  }

  private flushAll(reason: CutReason, now: number): void {
    if (this.pending.length === 0) return;
    this.emit(this.pending.splice(0), reason, now);
  }

  // Removes fillers (and the 、 after one) from the chunk text. A pattern ending in 、 only at the start of a sentence.
  private stripFillers(tokens: readonly Token[]): Token[] {
    if (this.fillers.size === 0 && this.sentenceStartFillers.size === 0) return [...tokens];
    const out: Token[] = [];
    let sentenceStart = this.atSentenceStart;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const next = tokens[i + 1];
      if (!t.punct) {
        const closes = next === undefined ? false : next.punct && (next.content === COMMA || next.content === "。");
        const plain = this.fillers.has(t.content) && closes;
        const lead = sentenceStart && this.sentenceStartFillers.has(t.content) && next?.content === COMMA;
        if (plain || lead) {
          if (next?.content === COMMA) i++;
          continue;
        }
      }
      out.push(t);
      sentenceStart = t.punct && SENTENCE_END.has(t.content);
    }
    return out;
  }

  private emit(tokens: Token[], reason: CutReason, now: number): void {
    if (tokens.length === 0) return;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    let merged = 0;
    for (const t of tokens) {
      if (t.heldBoundary) merged++;
      if (t.verified) continue;
      let rec = this.emittedByResult.get(t.resultId);
      if (!rec) this.emittedByResult.set(t.resultId, (rec = []));
      rec.push({ content: t.content, punct: t.punct });
    }
    const last = tokens[tokens.length - 1];
    const kept = this.stripFillers(tokens);
    this.atSentenceStart = last.punct && SENTENCE_END.has(last.content) ? true : reason === "final" || reason === "eof" || reason === "error";
    const text = joinJapanese(kept);
    const words = kept.filter((t) => !t.punct);
    if (!text || words.length === 0) {
      log.debug(`[segmenter-ja] dropped chunk without text "${tokens.map((t) => t.content).join("")}"`);
      return;
    }
    const resultCounts: Record<string, number> = {};
    for (const t of tokens) resultCounts[t.resultId] = (resultCounts[t.resultId] ?? 0) + 1;
    this.onChunk({
      english: text, // the chunk's source text (Japanese here); the field name is shared with the English segmenter
      reason,
      words: charCount(kept),
      resultId: tokens[0].resultId,
      resultCounts,
      audioStart: words[0].start,
      audioEnd: Math.max(...words.map((t) => t.end)),
      committedAt: now,
      ...(merged > 0 ? { merged } : {}),
      lastToken: words[words.length - 1].content,
    });
  }

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
      log.info(`[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length}${heldStr} OK final="${joinJapanese(finalTokens)}"`);
    } else {
      log.warn(
        `[verify] result=${id.slice(0, 8)} items=${finalTokens.length} committed=${emitted.length}${heldStr} MISMATCH ` +
          `committed="${joinJapanese(emitted)}" final="${joinJapanese(finalTokens)}"`,
      );
    }
  }
}


// Options of the Japanese segmenter from the global config (ja* keys, merge-short keys and the Japanese filler list).
export function jaSegmenterOptions(cfg: typeof GlobalConfig): JaSegmenterOptions {
  const j = cfg.jaSegmentation;
  return {
    mode: j.mode,
    maxWaitMs: j.maxWaitMs,
    mergeShort: cfg.segmentation.mergeShort,
    sentenceMinChars: j.sentenceMinChars,
    mergePauseMs: cfg.segmentation.mergePauseMs,
    mergeMaxHoldMs: cfg.segmentation.mergeMaxHoldMs,
    clauseMinChars: j.clauseMinChars,
    maxChars: j.maxChars,
    pauseMs: j.pauseMs,
    clauseEndings: j.clauseEndings,
    danglingTokens: j.danglingTokens,
    danglingMaxChars: j.danglingMaxChars,
    fillerPatterns: cfg.fillers.enabled ? cfg.fillers.jaPatterns : [],
  };
}
