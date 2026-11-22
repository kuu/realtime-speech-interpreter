// LanguageGate: sits between Transcribe (multi-language identification) and the Segmenter
// and forwards only results identified as the source language (en-US), so Japanese speech
// (moderator, audience questions) is never translated or spoken. Pure and synchronous,
// clock injected, like the Segmenter.
//
// Rules per ResultId (Transcribe tags every partial and final with a LanguageCode):
//   partial, source language: forwarded once the result has "settled" = it was already
//     forwarded, or its stable prefix has >= settleWords words. The language of a result can
//     flip once near its start (and the items are re-transcribed); waiting a few stable words
//     keeps the first words of a Japanese question out. While settling, only the activity is
//     reported to the segmenter (pause timers behave as before).
//     Dynamic settle (LANGID_SETTLE_MODE=dynamic): the threshold is settleWordsDefault (3) while no
//     non-source result (partial or final, any result) was seen in the last jaMemoryMs, and
//     settleWordsAfterJa (5) after one. Language flips (and the short en-US fragments inside a
//     Japanese passage) happen right after Japanese speech, so the long threshold only costs latency
//     there. A result that itself began as non-source and flipped counts as "after Japanese" too, and so does a
//     result whose partials shrank (fewer items than an earlier partial) before it settled: Transcribe rewriting
//     itself is how the first Japanese turn after English speech looks (J3 "I. So there are no" -> はい、ありがとうございます).
//     mode=fixed (default) uses settleWords for every result, exactly as before.
//   partial, other language: never forwarded.
//   final, source language: forwarded (the segmenter commits the rest and verifies), except a
//     short low-confidence result that follows a non-source final and was never forwarded
//     (en-US fragments inside a Japanese passage): dropped, reason=short-low-conf.
//   final, other language: dropped (reason=non-english). If its partials were already
//     forwarded (late flip), the segmenter removes its un-emitted tokens (reason=non-english-late).
//   endOfStream: an unsettled source-language partial is forwarded so the segmenter's eof
//     logic commits it exactly as before; open other-language results are dropped.
// A result without LanguageCode is treated as the source language.
//
// Split results: with language identification Transcribe often closes a result with FEWER
// items than it had already marked stable, and the next result re-transcribes that audio
// (same item times; it may even start earlier, inside audio the previous final covered).
// Those words were committed (maybe spoken) already. So the gate keeps a high-water mark of
// committed audio (max item EndTime, stream seconds); a new result never forwards items whose
// midpoint is at or before the mark as it was when the result appeared, and a final that is a
// strict prefix of what was committed is passed on as exactly the committed items ([verify] OK).

import {
  LANGID_JA_MEMORY_MS,
  LANGID_SETTLE_ITEMS,
  LANGID_SETTLE_ITEMS_AFTER_EN,
  LANGID_SETTLE_ITEMS_DEFAULT,
  LANGID_SETTLE_WORDS_AFTER_JA,
  LANGID_SETTLE_WORDS_DEFAULT,
} from "./langid-defaults.js";
import { log } from "./log.js";
import { isPunctItem, type Segmenter, type TxItem, type TxResult } from "./segmenter.js";

export interface LanguageGateOptions {
  source: string; // e.g. en-US
  settleWords: number; // stable words before a source-language partial is forwarded (fixed mode)
  settleMode?: "fixed" | "dynamic"; // default fixed
  settleWordsDefault?: number; // dynamic: threshold when no non-source result was seen recently (default 3)
  settleWordsAfterJa?: number; // dynamic: threshold within jaMemoryMs after a non-source result (default 5)
  // Same three thresholds for a ja-JP source, in stable items instead of words (used only when source is ja-*).
  settleItems?: number; // fixed mode (default 5)
  settleItemsDefault?: number; // dynamic: no non-source result seen recently (default 3)
  settleItemsAfterEn?: number; // dynamic: within jaMemoryMs after a non-source result (default 5)
  jaMemoryMs?: number; // dynamic: how long a non-source result keeps the long threshold (default 60000)
  shortWords: number; // short-low-conf rule: max words (0 disables)
  shortMinConf: number; // short-low-conf rule: mean confidence below this is dropped
  jaFillers?: readonly string[]; // Japanese filler patterns hidden from the as-said caption (config fillers.jaPatterns)
}

// Optional observer of Japanese speech (live captions, shown as said). Receives only STABLE words of results
// that are Japanese and were never forwarded as English; the audio path (Translate, LLM, Polly) never sees them.
export interface JapaneseSpeechTap {
  // tokens carry the audio times (stream seconds) of the item when Transcribe gave them.
  onSpeech(b: { resultId: string; tokens: { content: string; punct: boolean; start?: number; end?: number }[]; final: boolean; audioEnd: number }): void;
  // Words of this result were published and the result turned out not to be Japanese (language flip).
  onRetract(resultId: string): void;
  // The result is final and has no more words (also called when the final adds nothing new).
  onResultEnd?(resultId: string): void;
  // The Transcribe stream ended: whatever the tap still holds must go out.
  onStreamEnd?(): void;
}
// Stable non-punctuation items a Japanese partial needs before its words are shown (Japanese items are short
// tokens; language flips happen at the start of a result, as for English).
export const JA_SETTLE_ITEMS = 3;
const JA_LANG = /^ja(-|$)/i;
// A result tagged Japanese whose words contain no Japanese character (hiragana, katakana, kanji) is English
// speech mis-tagged for a moment ("weseabugpvenand"); it is not shown until a Japanese character appears.
const JA_CHAR = /[\u3040-\u30ff\u3400-\u9fff]/u;
export interface ResultSink {
  onResult(r: TxResult, now: number): void;
  endOfStream(reason: "eof" | "error", now: number): void;
}

export type DropReason = "non-english" | "short-low-conf" | "non-english-late" | "non-english-eof";

interface GateState {
  passed: boolean; // at least one partial was forwarded to the segmenter
  last: TxResult | null; // last partial seen
  sig: string; // activity detection while settling
  hw0: number; // committed-audio mark when this result appeared (its items up to here are repeats)
  repeats: boolean; // some items of this result were repeats of committed audio
  maxItems: number; // most items any source-language partial of this result had so far
  volatile: boolean; // a partial had fewer items than an earlier one before the result settled (dynamic mode)
  fwdCommitted: TxItem[]; // mirror of what the segmenter committed for this result (forwarded items)
  jaOn: boolean; // Japanese words of this result were published (a retract is owed if it flips)
  jaHw0: number; // Japanese audio already published when this result appeared (its items up to here are repeats)
  jaEnd: number; // end of the audio already consumed by the Japanese tap (published or hidden fillers)
}

function items(r: TxResult): TxItem[] {
  return (r.Alternatives?.[0]?.Items ?? []).filter((it) => (it.Content ?? "") !== "");
}
function withItems(r: TxResult, its: TxItem[]): TxResult {
  const alt = r.Alternatives?.[0] ?? {};
  return { ...r, Alternatives: [{ ...alt, Items: its }] };
}
// Item audio already committed by an earlier result (items without times are always new).
function isRepeat(it: TxItem, hw: number): boolean {
  if (typeof it.StartTime !== "number" || typeof it.EndTime !== "number") return false;
  return (it.StartTime + it.EndTime) / 2 <= hw;
}
function wordCount(its: readonly TxItem[]): number {
  return its.filter((it) => !isPunctItem(it)).length;
}
function stableWords(its: readonly TxItem[]): number {
  let n = 0;
  for (const it of its) {
    if (it.Stable !== true) break;
    if (!isPunctItem(it)) n++;
  }
  return n;
}
function meanConf(its: readonly TxItem[]): number | null {
  const c = its.filter((it) => !isPunctItem(it) && typeof it.Confidence === "number").map((it) => it.Confidence as number);
  return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
}

export class LanguageGate implements ResultSink {
  private open = new Map<string, GateState>();
  private prevFinalLang: string | null = null;
  private hw = -Infinity; // max EndTime of items committed to the segmenter (this stream)
  private jaHw = -Infinity; // max EndTime of Japanese items published (this stream)
  private lastNonSourceAt = -Infinity; // wall time (ms) of the latest non-source result seen
  readonly stats = { results: 0, kept: 0, dropped: 0, droppedWords: 0, late: 0, carried: 0, repeats: 0, settledAfterJa: 0 };

  constructor(
    private readonly opts: LanguageGateOptions,
    private readonly segmenter: Segmenter,
    private readonly t0: () => number,
    private readonly jaTap?: JapaneseSpeechTap,
  ) {}

  private langOf(r: TxResult): string {
    return r.LanguageCode || this.opts.source;
  }

  // Stable words a source-language partial needs before it is forwarded, and whether the long (after-Japanese) value applies.
  // For a ja-JP source the same table applies in stable items (words = items), with the settleItems* options.
  private settleAt(now: number, st: GateState): { words: number; afterJa: boolean } {
    const ja = JA_LANG.test(this.opts.source);
    if (this.opts.settleMode !== "dynamic") {
      return { words: ja ? (this.opts.settleItems ?? LANGID_SETTLE_ITEMS) : this.opts.settleWords, afterJa: false };
    }
    // A result whose partials shrank before it settled is rewriting itself (Japanese speech heard as English):
    // it gets the long threshold even when no Japanese result was seen recently (first Japanese turn after English).
    const afterJa = st.volatile || now - this.lastNonSourceAt <= (this.opts.jaMemoryMs ?? LANGID_JA_MEMORY_MS);
    if (ja) {
      return afterJa
        ? { words: this.opts.settleItemsAfterEn ?? LANGID_SETTLE_ITEMS_AFTER_EN, afterJa }
        : { words: this.opts.settleItemsDefault ?? LANGID_SETTLE_ITEMS_DEFAULT, afterJa };
    }
    return afterJa
      ? { words: this.opts.settleWordsAfterJa ?? LANGID_SETTLE_WORDS_AFTER_JA, afterJa }
      : { words: this.opts.settleWordsDefault ?? LANGID_SETTLE_WORDS_DEFAULT, afterJa };
  }

  private mark(its: readonly TxItem[]): void {
    for (const it of its) if (typeof it.EndTime === "number" && it.EndTime > this.hw) this.hw = it.EndTime;
  }

  // Items of this result that are not repeats of committed audio.
  private fresh(st: GateState, its: TxItem[]): TxItem[] {
    const out = its.filter((it) => !isRepeat(it, st.hw0));
    if (out.length < its.length && !st.repeats) {
      st.repeats = true;
      this.stats.repeats++;
    }
    return out;
  }

  onResult(r: TxResult, now: number): void {
    if (!r.Alternatives?.[0]) return;
    const id = r.ResultId ?? "default";
    let st = this.open.get(id);
    if (!st) {
      st = { passed: false, last: null, sig: "", hw0: this.hw, repeats: false, maxItems: 0, volatile: false, fwdCommitted: [], jaOn: false, jaHw0: this.jaHw, jaEnd: -Infinity };
      this.open.set(id, st);
    }
    const lang = this.langOf(r);
    const raw = items(r);
    const isSource = lang === this.opts.source;

    if (!isSource && raw.length > 0) this.lastNonSourceAt = now;

    if (r.IsPartial) {
      st.last = r;
      if (!isSource) {
        if (JA_LANG.test(lang)) this.showJapanese(id, st, raw, false);
        else this.retractJapanese(id, st);
        return;
      }
      if (raw.length > 0) this.retractJapanese(id, st);
      const fwd = this.fresh(st, raw);
      if (st.repeats) st.passed = true; // continuation of English already committed
      if (!st.passed) {
        if (raw.length < st.maxItems) st.volatile = true;
        st.maxItems = Math.max(st.maxItems, raw.length);
      }
      const settle = this.settleAt(now, st);
      if (st.passed || stableWords(fwd) >= settle.words) {
        if (!st.passed && settle.afterJa) this.stats.settledAfterJa++;
        st.passed = true;
        // Mirror the segmenter's commit rule (stable prefix, never shrinks).
        let stable = 0;
        while (stable < fwd.length && fwd[stable].Stable === true) stable++;
        if (stable > st.fwdCommitted.length) {
          const add = fwd.slice(st.fwdCommitted.length, stable);
          st.fwdCommitted.push(...add);
          this.mark(add);
        }
        this.segmenter.onResult(fwd.length === raw.length ? r : withItems(r, fwd), now);
        return;
      }
      const sig = fwd.map((it) => `${it.Content}${it.Stable ? "+" : "-"}`).join(" ");
      if (sig !== st.sig) {
        st.sig = sig;
        this.segmenter.noteActivity(now);
      }
      return;
    }

    // Final.
    this.open.delete(id);
    this.stats.results++;
    if (isSource) {
      if (raw.length > 0) this.retractJapanese(id, st);
      const fin = this.fresh(st, raw);
      const c = st.fwdCommitted;
      let segItems = fin;
      if (fin.length < c.length && fin.every((it, i) => it.Content === c[i].Content)) {
        // Split: the final ends inside what was already committed; the next result repeats the rest.
        const overflow = c.slice(fin.length);
        this.stats.carried++;
        log.info(
          `[langfilter] carry result=${id.slice(0, 8)} items=${overflow.length} ` +
            `text="${overflow.map((it) => it.Content).join(" ")}" (final shorter than committed; next result repeats it)`,
        );
        segItems = c; // exactly what the segmenter committed → [verify] OK, nothing re-emitted
      }
      if (st.passed || st.repeats) {
        // Already forwarded, or a continuation of committed English: never subject to the
        // short-low-conf rule. An unforwarded result that only repeats committed audio adds nothing.
        this.stats.kept++;
        this.prevFinalLang = lang;
        if (st.passed || segItems.length > 0) this.forwardFinal(r, raw, segItems, now);
        else this.segmenter.noteActivity(now);
        return;
      }
      const words = wordCount(raw);
      const conf = meanConf(raw);
      if (
        this.opts.shortWords > 0 &&
        words > 0 &&
        words <= this.opts.shortWords &&
        conf !== null &&
        conf < this.opts.shortMinConf &&
        this.prevFinalLang !== null &&
        this.prevFinalLang !== this.opts.source
      ) {
        this.drop(r, "short-low-conf", lang, now);
        return; // prevFinalLang unchanged: a chain of fragments stays inside the passage
      }
      this.stats.kept++;
      this.prevFinalLang = lang;
      this.forwardFinal(r, raw, segItems, now);
      return;
    }
    this.prevFinalLang = lang;
    if (JA_LANG.test(lang)) this.showJapanese(id, st, raw, true);
    else this.retractJapanese(id, st);
    if (st.passed) {
      this.segmenter.closeResult(id, lang, now);
      this.stats.late++;
      this.drop(r, "non-english-late", lang, now);
    } else {
      this.drop(r, "non-english", lang, now);
    }
  }

  // Japanese speech as said: publish the stable words of a Japanese result that was never forwarded as English.
  // The words are never sent to the segmenter, so nothing here can reach Translate, the LLM or Polly.
  private showJapanese(id: string, st: GateState, all: TxItem[], final: boolean): void {
    const tap = this.jaTap;
    if (!tap || st.passed) return;
    // Like English: the next result often re-transcribes audio the previous one already covered. Items whose
    // midpoint is at or before the Japanese published so far (when this result appeared) are repeats; items of
    // this result already consumed are found by time, so a re-tokenised final never repeats them.
    const its = all.filter((it) => !isRepeat(it, st.jaHw0));
    let n = 0;
    while (n < its.length && (final || its[n].Stable === true)) n++;
    if (!st.jaOn) {
      if (!final && wordCount(its.slice(0, n)) < JA_SETTLE_ITEMS) return;
      if (!its.slice(0, n).some((it) => JA_CHAR.test(it.Content ?? ""))) return;
      st.jaOn = true;
    }
    const fillers = (this.opts.jaFillers ?? []).map((p) => p.trim()).filter(Boolean);
    const isPunctJa = (it: TxItem | undefined) => !!it && isPunctItem(it);
    const wordsOf = (p: string) => p.replace(/、$/, "");
    const fillerAt = (i: number): boolean => {
      const it = its[i];
      if (isPunctItem(it)) return false;
      const c = (it.Content ?? "").trim();
      const next = its[i + 1];
      const prevBreak = i === 0 || /^[。！？!?]$/.test(its[i - 1].Content ?? "");
      for (const p of fillers) {
        if (wordsOf(p) !== c) continue;
        if (p.endsWith("、")) {
          if (prevBreak && isPunctJa(next) && next.Content === "、") return true; // "つまり、" only at sentence start
        } else if (final && next === undefined) {
          return true; // a hesitation closing the result
        } else if (isPunctJa(next) && /^[、。]$/.test(next.Content ?? "")) {
          return true;
        }
      }
      return false;
    };
    const consumed = (it: TxItem) => typeof it.StartTime === "number" && typeof it.EndTime === "number" && (it.StartTime + it.EndTime) / 2 <= st.jaEnd;
    let first = 0;
    while (first < n && consumed(its[first])) first++;
    let upto = n;
    // A possible filler at the end of the stable prefix is held back until the next item shows what follows it.
    if (!final && upto > first && !isPunctItem(its[upto - 1]) && fillers.some((p) => wordsOf(p) === (its[upto - 1].Content ?? "").trim())) upto--;
    if (upto <= first) {
      if (final) this.endJapanese(id);
      return;
    }
    const tokens: { content: string; punct: boolean; start?: number; end?: number }[] = [];
    let audioEnd = 0;
    for (let i = first; i < upto; i++) {
      const it = its[i];
      if (typeof it.EndTime === "number") audioEnd = Math.max(audioEnd, it.EndTime);
      if (fillerAt(i)) {
        // drop the filler and the comma that followed it
        if (i + 1 < upto && isPunctJa(its[i + 1]) && its[i + 1].Content === "、") {
          i++;
          if (typeof its[i].EndTime === "number") audioEnd = Math.max(audioEnd, its[i].EndTime as number);
        }
        continue;
      }
      tokens.push({ content: it.Content ?? "", punct: isPunctItem(it), start: it.StartTime, end: it.EndTime });
    }
    st.jaEnd = Math.max(st.jaEnd, audioEnd);
    this.jaHw = Math.max(this.jaHw, audioEnd);
    try {
      tap.onSpeech({ resultId: id, tokens, final: final && upto >= its.length, audioEnd });
    } catch (err) {
      log.warn(`[langfilter] japanese tap error: ${String(err)}`);
    }
    if (final) this.endJapanese(id);
  }
  private endJapanese(id: string): void {
    try {
      this.jaTap?.onResultEnd?.(id);
    } catch (err) {
      log.warn(`[langfilter] japanese tap error: ${String(err)}`);
    }
  }
  private retractJapanese(id: string, st: GateState): void {
    if (!st.jaOn) return;
    st.jaOn = false;
    st.jaEnd = -Infinity;
    try {
      this.jaTap?.onRetract(id);
    } catch (err) {
      log.warn(`[langfilter] japanese tap error: ${String(err)}`);
    }
  }
  private forwardFinal(r: TxResult, raw: TxItem[], segItems: TxItem[], now: number): void {
    this.mark(segItems);
    this.segmenter.onResult(segItems === raw ? r : withItems(r, segItems), now);
  }

  endOfStream(reason: "eof" | "error", now: number): void {
    for (const [id, st] of this.open) {
      if (!st.last) continue;
      this.stats.results++;
      const lang = this.langOf(st.last);
      if (JA_LANG.test(lang)) this.showJapanese(id, st, items(st.last), true);
      else if (lang !== this.opts.source) this.retractJapanese(id, st);
      if (lang === this.opts.source) {
        this.retractJapanese(id, st);
        this.stats.kept++;
        // eof commits it, incl. unstable items (an unsettled result has no repeats)
        if (!st.passed) this.segmenter.onResult(st.last, now);
      } else {
        if (st.passed) {
          this.segmenter.closeResult(id, lang, now);
          this.stats.late++;
        }
        this.drop(st.last, "non-english-eof", lang, now);
      }
    }
    this.open.clear();
    try {
      this.jaTap?.onStreamEnd?.();
    } catch (err) {
      log.warn(`[langfilter] japanese tap error: ${String(err)}`);
    }
    this.segmenter.endOfStream(reason, now);
  }

  summary(attempt: number): string {
    const s = this.stats;
    return (
      `[langfilter] stream=${attempt} results=${s.results} kept=${s.kept} dropped=${s.dropped} ` +
      `droppedWords=${s.droppedWords} late=${s.late} carried=${s.carried} repeats=${s.repeats}` +
      (this.opts.settleMode === "dynamic" ? ` settledAfterJa=${s.settledAfterJa}` : "")
    );
  }

  private drop(r: TxResult, reason: DropReason, lang: string, now: number): void {
    const its = items(r);
    const words = wordCount(its);
    if (words === 0) return; // nothing would have been spoken
    this.stats.dropped++;
    this.stats.droppedWords += words;
    const conf = meanConf(its);
    const start = r.StartTime ?? its[0]?.StartTime ?? 0;
    const end = r.EndTime ?? its[its.length - 1]?.EndTime ?? start;
    const lagMs = Math.round(now - (this.t0() + end * 1000));
    const text = (r.Alternatives?.[0]?.Transcript ?? its.map((it) => it.Content).join(" ")).replace(/\s+/g, " ").trim();
    log.info(
      `[langfilter] dropped result=${(r.ResultId ?? "default").slice(0, 8)} reason=${reason} lang=${lang} ` +
        `words=${words} conf=${conf === null ? "-" : conf.toFixed(2)} audio=${start.toFixed(2)}-${end.toFixed(2)}s ` +
        `lagMs=${lagMs} text="${text}"`,
    );
  }
}

// "off" returns the segmenter itself: results go straight to it, exactly as before.
export function createResultSink(
  mode: "off" | "langid",
  segmenter: Segmenter,
  opts: LanguageGateOptions,
  t0: () => number,
  jaTap?: JapaneseSpeechTap,
): ResultSink {
  return mode === "off" ? segmenter : new LanguageGate(opts, segmenter, t0, jaTap);
}
