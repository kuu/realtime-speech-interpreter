// Caption logic for the listener page. Pure ES module: no DOM, no globals, no imports, so it can be
// unit-tested with node:test (app/test/captions-assembler.test.ts). The page (subscriber.js) feeds it
// events and renders the model with textContent only.
//
// Event contract (v1, see docs/architecture.md):
//   {"v":1,"type":"caption", id, seq, channel:"ja", text, speaker, final, ...}    Japanese line, sent when its audio starts
//   {"v":1,"type":"source","op":"append", resultId, channel:"en", text, boundary}  English words as recognised
//   {"v":1,"type":"source","op":"retract", resultId}                               those words were not English after all
//   {"v":1,"type":"speech","op":"append", resultId, channel:"ja", asSaid:true, text, boundary}  Japanese speech, shown as said
//   {"v":1,"type":"speech","op":"retract", resultId, asSaid:true}                  those words were not Japanese after all
// Unknown fields, unknown types and unknown versions are ignored.

export const MAX_TEXT = 600;
// Display-only marker in front of a Japanese line shown as said (full-width dash U+2015 + space). Not part of any event text.
export const SAID_MARKER = "\u2015 ";

/**
 * @typedef {{ id: string, text: string, shown: string, said: boolean, state: "live" | "old" | "fading" }} LineModel
 * @typedef {{ kind: "caption", id: string, text: string, channel: string, speaker: unknown }
 *   | { kind: "source", op: "append", resultId: string, text: string, boundary: boolean, channel: string, speaker: unknown }
 *   | { kind: "source", op: "retract", resultId: string }
 *   | { kind: "speech", op: "append", resultId: string, text: string, boundary: boolean, channel: string, speaker: unknown }
 *   | { kind: "speech", op: "retract", resultId: string }} ParsedEvent
 */

/** Parse one data packet (Uint8Array or string). Never throws; returns null for anything not usable. */
export function parseEvent(data) {
  let o;
  try {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data);
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  const channel = typeof o.channel === "string" ? o.channel : "";
  if (o.type === "caption") {
    if (o.final === false) return null; // reserved for later partial updates
    if (!validText(o.text)) return null;
    return { kind: "caption", id: String(o.id ?? ""), text: o.text, channel, speaker: o.speaker ?? null };
  }
  if (o.type === "source") {
    if (typeof o.resultId !== "string" || o.resultId === "") return null;
    if (o.op === "retract") return { kind: "source", op: "retract", resultId: o.resultId };
    if (o.op === "append") {
      if (!validText(o.text)) return null;
      return { kind: "source", op: "append", resultId: o.resultId, text: o.text, boundary: o.boundary === true, channel, speaker: o.speaker ?? null };
    }
  }
  if (o.type === "speech") {
    // Only Japanese speech shown as said is understood; anything else (another language, a later variant) is ignored.
    if (o.asSaid !== true || channel !== "ja") return null;
    if (typeof o.resultId !== "string" || o.resultId === "") return null;
    if (o.op === "retract") return { kind: "speech", op: "retract", resultId: o.resultId };
    if (o.op === "append") {
      if (!validText(o.text)) return null;
      return { kind: "speech", op: "append", resultId: o.resultId, text: o.text, boundary: o.boundary === true, channel, speaker: o.speaker ?? null };
    }
  }
  return null;
}
/** Back-compat helper: the Japanese caption event only. */
export function parseCaptionEvent(data) {
  const ev = parseEvent(data);
  return ev && ev.kind === "caption" ? ev : null;
}

function validText(t) {
  return typeof t === "string" && t.trim() !== "" && Array.from(t).length <= MAX_TEXT;
}

/** English is shown unless the URL has ?source=off. Any other value (or none) keeps it on. */
export function parseSourceOption(search) {
  const q = String(search || "").replace(/^\?/, "");
  for (const pair of q.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k === "source" && v.toLowerCase() === "off") return false;
  }
  return true;
}

const LEADING_PUNCT = /^[.,?!;:、。！？，]/;
const SENTENCE_END = /[。？！?!.]["')」』”]*$/;
const ASCII_EDGE = (a, b) => /[A-Za-z0-9]$/.test(a) || /^[A-Za-z0-9]/.test(b);

function joinText(a, b, spaced) {
  if (!a) return b;
  if (!b) return a;
  if (LEADING_PUNCT.test(b)) return a + b;
  return spaced || ASCII_EDGE(a, b) ? `${a} ${b}` : a + b;
}

const len = (s) => Array.from(s).length;

// Shared rolling-line store: merges pieces into the open line, closes it at sentence end / max length /
// quiet gap, keeps at most maxLines, and expires lines (fade, then removal).
class Lines {
  constructor(o, prefix, spaced, closeOn, splitLong = false) {
    this.o = o;
    this.splitLong = splitLong; // true: a line longer than maxLineChars is cut (at a comma, else a word) and goes on in a new line
    this.prefix = prefix;
    this.spaced = spaced;
    this.closeOn = closeOn; // regex: line ends here
    this.lines = [];
    this.n = 1;
  }

  add(text, resultId, now, closeAfter, kind = "") {
    let line = this.lines[this.lines.length - 1];
    // Never two sources (translated vs as said) in one line: a change of kind starts a new line.
    if (line && !line.closed && line.kind !== kind) line.closed = true;
    if (!line || line.closed) {
      // A line that was closed only because it reached the maximum length continues the same utterance.
      const contOf = line && line.closedByLength && line.kind === kind ? line : null;
      line = { id: `${this.prefix}${this.n++}`, segs: [], closed: false, updatedAt: now, text: "", kind, contOf, closedByLength: false };
      this.lines.push(line);
      while (this.lines.length > this.o.maxLines) this.lines.shift();
    }
    line.segs.push({ resultId, text });
    line.updatedAt = now;
    line.text = this.render(line);
    this.settle(line, closeAfter, now);
  }

  // Cuts an over-long line, then closes the last part if it ends a sentence (or the caller says so).
  settle(line, closeAfter, now) {
    while (this.splitLong && len(line.text) > this.o.maxLineChars) {
      const cut = this.cutPoint(line.text);
      const next = { id: `${this.prefix}${this.n++}`, segs: [], closed: false, updatedAt: now, text: "", kind: line.kind, contOf: line, closedByLength: false };
      let pos = 0;
      const keep = [];
      for (const sg of line.segs) {
        const start = pos === 0 ? 0 : line.text.indexOf(sg.text, pos);
        const end = start + sg.text.length;
        pos = end;
        const head = sg.text.slice(0, Math.max(0, Math.min(end, cut) - start)).trimEnd();
        const tail = sg.text.slice(Math.max(0, cut - start)).trimStart();
        if (head !== "") keep.push({ resultId: sg.resultId, text: head });
        if (tail !== "") next.segs.push({ resultId: sg.resultId, text: tail });
      }
      line.segs = keep;
      line.text = this.render(line);
      line.closed = true;
      line.closedByLength = true;
      next.text = this.render(next);
      this.lines.push(next);
      while (this.lines.length > this.o.maxLines) this.lines.shift();
      line = next;
    }
    if (closeAfter || this.closeOn.test(line.text)) line.closed = true;
    else if (!this.splitLong && len(line.text) >= this.o.maxLineChars) {
      line.closed = true;
      line.closedByLength = true;
    }
  }

  // Where to cut a line longer than the limit: just after the last comma, semicolon or colon within the limit,
  // else at the last space within it, else at the limit itself.
  cutPoint(text) {
    const max = this.o.maxLineChars;
    const head = text.slice(0, max + 1);
    let i = -1;
    for (let k = max - 1; k > 0; k--) {
      if (",;:".includes(head[k])) {
        i = k + 1;
        break;
      }
    }
    if (i < 0) i = head.lastIndexOf(" ");
    return i > 0 ? i : max;
  }

  render(line) {
    let t = "";
    for (const s of line.segs) t = joinText(t, s.text, this.spaced);
    return t;
  }

  retract(resultId) {
    for (const l of this.lines) {
      const before = l.segs.length;
      l.segs = l.segs.filter((s) => s.resultId !== resultId);
      if (l.segs.length !== before) l.text = this.render(l);
    }
    this.lines = this.lines.filter((l) => l.segs.length > 0);
  }

  tick(now) {
    for (const l of this.lines) if (!l.closed && now - l.updatedAt >= this.o.lineGapMs) l.closed = true;
    this.lines = this.lines.filter((l) => now - l.updatedAt < this.o.lineTtlMs + this.o.fadeMs);
  }

  /** @returns {LineModel[]} */
  model(now) {
    const last = this.lines.length - 1;
    return this.lines
      .filter((l) => now - l.updatedAt < this.o.lineTtlMs + this.o.fadeMs)
      .map((l, i, all) => ({
        id: l.id,
        text: l.text,
        said: l.kind === "said",
        // The ― marks a new as-said utterance; a continuation line of a long one does not repeat it.
        shown: l.kind === "said" && !(l.contOf && all[i - 1] === l.contOf) ? SAID_MARKER + l.text : l.text,
        state: now - l.updatedAt >= this.o.lineTtlMs ? "fading" : i === last ? "live" : "old",
      }));
  }
}

const JA_SENTENCE_END = /[。？！?!]["')」』”]*$/;
// An as-said line waits at most this long (ms) for the translated sentence it would interrupt.
export const SAID_QUEUE_MS = 3000;
const JA_DEFAULTS = { maxLines: 3, maxLineChars: 60, lineGapMs: 6000, lineTtlMs: 12000, fadeMs: 600 };
// English lines group by sentence: a pause does not close a line (only a sentence end or the maximum length does;
// an idle line expires after lineTtlMs), because Transcribe results end in the middle of sentences.
// Safety limit only: the page wraps long lines itself. It guards against a speaker who never ends a sentence.
export const EN_MAX_LINE_CHARS = 240;
const EN_DEFAULTS = { maxLines: 3, maxLineChars: EN_MAX_LINE_CHARS, lineGapMs: 10000, lineTtlMs: 10000, fadeMs: 600 };

/**
 * Japanese caption assembler. Consecutive caption events (same channel and speaker) merge into one line
 * until it ends with 。？！ or reaches maxLineChars; a quiet gap closes it too. With `asSaid` events (type "speech")
 * the same store also holds Japanese speech shown as said; a change between translated and as-said text always
 * starts a new line, and a retract removes the words of that result.
 */
export function createAssembler(opts = {}, showSpeech = true) {
  const { queueMs = SAID_QUEUE_MS, ...rest } = opts;
  const store = new Lines({ ...JA_DEFAULTS, ...rest }, "ja", false, JA_SENTENCE_END);
  let key = "";
  let transAt = -Infinity; // time of the newest translation text
  let queue = []; // as-said events waiting for an open translated sentence to end: { ev, at }
  // The newest translated line is still open: its text does not end with 。？！ (or ?!) and closing brackets.
  const translationOpen = () => {
    for (let i = store.lines.length - 1; i >= 0; i--) {
      const l = store.lines[i];
      if (l.kind === "") return !JA_SENTENCE_END.test(l.text);
    }
    return false;
  };
  const placeSaid = (ev, now) => {
    if (key !== "" && key !== "said") {
      const l = store.lines[store.lines.length - 1];
      if (l) l.closed = true;
    }
    key = "said";
    // A sentence event starts a new line with its own marker. Only the rest of a sentence that the server released
    // early (it had no end within the hold time) joins the as-said line it continues: same result, line not ended.
    const last = store.lines[store.lines.length - 1];
    if (last && last.closed && !last.closedByLength && last.kind === "said" && last.segs.length > 0 &&
        last.segs[last.segs.length - 1].resultId === ev.resultId && !JA_SENTENCE_END.test(last.text)) last.closed = false;
    store.add(ev.text, ev.resultId, now, ev.boundary, "said");
  };
  const release = (n, now) => {
    for (const q of queue.splice(0, n)) placeSaid(q.ev, now);
  };
  return {
    /** @param {ParsedEvent | null} ev */
    push(ev, now) {
      if (ev && ev.kind === "speech") {
        if (!showSpeech) return false;
        if (ev.op === "retract") {
          queue = queue.filter((q) => q.ev.resultId !== ev.resultId);
          store.retract(ev.resultId);
          return true;
        }
        // A translated sentence is still being shown (its voice-synced lines arrive later than the as-said words):
        // the as-said line waits, in order, until that sentence ends, a timeout, or no new translated text for a while.
        if (queue.length > 0 || (translationOpen() && now - transAt < queueMs)) {
          queue.push({ ev, at: now });
          return true;
        }
        placeSaid(ev, now);
        return true;
      }
      if (!ev || ev.kind !== "caption" || (ev.channel !== "ja" && ev.channel !== "")) return false;
      const k = `${ev.channel}|${ev.speaker === null ? "" : JSON.stringify(ev.speaker)}`;
      if (key !== "" && k !== key) {
        const l = store.lines[store.lines.length - 1];
        if (l) l.closed = true; // another speaker starts a new line
      }
      key = k;
      store.add(ev.text, null, now, false);
      transAt = now;
      if (queue.length > 0 && !translationOpen()) release(queue.length, now);
      return true;
    },
    tick(now) {
      if (queue.length > 0) {
        // Everything up to the last line whose wait is over goes out, to keep the order.
        let n = 0;
        queue.forEach((q, i) => {
          if (now - q.at >= queueMs) n = i + 1;
        });
        if (now - transAt >= queueMs) n = queue.length;
        if (n > 0) release(n, now);
      }
      store.tick(now);
    },
    model: (now) => store.model(now),
  };
}
/**
 * English source assembler: appends word batches, closes lines at sentence ends, and removes all words of a
 * result when it is retracted. A retract for an unknown resultId is a no-op.
 */
export function createSourceAssembler(opts = {}) {
  const store = new Lines({ ...EN_DEFAULTS, ...opts }, "en", true, /[?!.]["')”]*$/, true);
  return {
    /** @param {ParsedEvent | null} ev */
    push(ev, now) {
      if (!ev || ev.kind !== "source") return false;
      if (ev.op === "retract") {
        store.retract(ev.resultId);
        return true;
      }
      if (ev.channel !== "en" && ev.channel !== "") return false;
      // A batch may contain several sentences: close the line at each sentence end inside it.
      const pieces = ev.text.split(/(?<=[.?!])\s+/).filter((p) => p !== "");
      // `boundary` only says that a sentence ends somewhere in the batch; the pieces already close at each of those.
      for (const p of pieces) store.add(p, ev.resultId, now, false);
      return true;
    },
    tick: (now) => store.tick(now),
    model: (now) => store.model(now),
  };
}

// ---- Layout (fixed once Listen is pressed) ----
// All numbers are CSS px. The caller measures once when captions go live (and again only when the width or the
// SMALL viewport height changes, i.e. a rotation or a window resize; the Safari toolbar changes neither):
//   svh        small viewport height (CSS 100svh), unaffected by the toolbar
//   safeBottom env(safe-area-inset-bottom)
//   hintBottom bottom edge of the hint paragraph (document coordinates; the page does not scroll)
//   jaFont, enFont  computed font sizes of the two areas (line-height is 1.5 em)
// The English area is pinned near the bottom; the Japanese area is bottom-anchored just above it and takes the
// space down from the hint, in whole lines.
export const LAYOUT = { maxJaLines: 8, maxEnLines: 3, minJaLines: 2, gapMin: 12, edge: 12, hintGap: 16 };
export function computeLayout({ svh, safeBottom, hintBottom, jaFont, enFont }) {
  const jaLh = jaFont * 1.5;
  const enLh = enFont * 1.5;
  const bottom = svh - Math.max(0, safeBottom) - LAYOUT.edge; // lowest y of the English area
  const jaMinTop = hintBottom + LAYOUT.hintGap;
  const gapFor = (lines) => Math.max(LAYOUT.gapMin, Math.round(enLh * (lines >= 2 ? 0.75 : 0.5)));
  let enLines = LAYOUT.maxEnLines;
  let jaLines = 0;
  for (; enLines >= 1; enLines--) {
    const enTop = bottom - enLines * enLh;
    jaLines = Math.floor((enTop - gapFor(enLines) - jaMinTop) / jaLh);
    if (jaLines >= LAYOUT.minJaLines) break;
  }
  if (enLines < 1) enLines = 1; // tiny screens: one English line, whatever Japanese space is left
  jaLines = Math.max(0, Math.min(LAYOUT.maxJaLines, jaLines));
  const enHeight = enLines * enLh;
  const enTop = bottom - enHeight;
  const jaHeight = jaLines * jaLh;
  const jaTop = enTop - gapFor(enLines) - jaHeight;
  return { jaLines, enLines, jaTop, jaHeight, enTop, enHeight };
}
