// Caption logic for the listener page. Pure ES module: no DOM, no globals, no imports, so it can be
// unit-tested with node:test (app/test/captions-assembler.test.ts). The page (subscriber.js) feeds it
// events and renders the model with textContent only.
//
// Event contract (v1, see docs/architecture.md):
//   {"v":1,"type":"caption", id, seq, channel:"ja", text, speaker, final, ...}    Japanese line, sent when its audio starts
//   {"v":1,"type":"source","op":"append", resultId, channel:"en", text, boundary}  English words as recognised
//   {"v":1,"type":"source","op":"retract", resultId}                               those words were not English after all
// Unknown fields, unknown types and unknown versions are ignored.

export const MAX_TEXT = 600;

/**
 * @typedef {{ id: string, text: string, state: "live" | "old" | "fading" }} LineModel
 * @typedef {{ kind: "caption", id: string, text: string, channel: string, speaker: unknown }
 *   | { kind: "source", op: "append", resultId: string, text: string, boundary: boolean, channel: string, speaker: unknown }
 *   | { kind: "source", op: "retract", resultId: string }} ParsedEvent
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
  constructor(o, prefix, spaced, closeOn) {
    this.o = o;
    this.prefix = prefix;
    this.spaced = spaced;
    this.closeOn = closeOn; // regex: line ends here
    this.lines = [];
    this.n = 1;
  }

  add(text, resultId, now, closeAfter) {
    let line = this.lines[this.lines.length - 1];
    if (!line || line.closed) {
      line = { id: `${this.prefix}${this.n++}`, segs: [], closed: false, updatedAt: now, text: "" };
      this.lines.push(line);
      while (this.lines.length > this.o.maxLines) this.lines.shift();
    }
    line.segs.push({ resultId, text });
    line.updatedAt = now;
    line.text = this.render(line);
    if (closeAfter || this.closeOn.test(line.text) || len(line.text) >= this.o.maxLineChars) line.closed = true;
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
      .map((l, i) => ({
        id: l.id,
        text: l.text,
        state: now - l.updatedAt >= this.o.lineTtlMs ? "fading" : i === last ? "live" : "old",
      }));
  }
}

const JA_DEFAULTS = { maxLines: 3, maxLineChars: 60, lineGapMs: 6000, lineTtlMs: 12000, fadeMs: 600 };
const EN_DEFAULTS = { maxLines: 3, maxLineChars: 90, lineGapMs: 4000, lineTtlMs: 10000, fadeMs: 600 };

/**
 * Japanese caption assembler. Consecutive caption events (same channel and speaker) merge into one line
 * until it ends with 。？！ or reaches maxLineChars; a quiet gap closes it too.
 */
export function createAssembler(opts = {}) {
  const store = new Lines({ ...JA_DEFAULTS, ...opts }, "ja", false, /[。？！?!]["')」』”]*$/);
  let key = "";
  return {
    /** @param {ParsedEvent | null} ev */
    push(ev, now) {
      if (!ev || ev.kind !== "caption" || (ev.channel !== "ja" && ev.channel !== "")) return false;
      const k = `${ev.channel}|${ev.speaker === null ? "" : JSON.stringify(ev.speaker)}`;
      if (key !== "" && k !== key) {
        const l = store.lines[store.lines.length - 1];
        if (l) l.closed = true; // another speaker starts a new line
      }
      key = k;
      store.add(ev.text, null, now, false);
      return true;
    },
    tick: (now) => store.tick(now),
    model: (now) => store.model(now),
  };
}

/**
 * English source assembler: appends word batches, closes lines at sentence ends, and removes all words of a
 * result when it is retracted. A retract for an unknown resultId is a no-op.
 */
export function createSourceAssembler(opts = {}) {
  const store = new Lines({ ...EN_DEFAULTS, ...opts }, "en", true, /[?!.]["')”]*$/);
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
      pieces.forEach((p, i) => store.add(p, ev.resultId, now, ev.boundary && i === pieces.length - 1));
      return true;
    },
    tick: (now) => store.tick(now),
    model: (now) => store.model(now),
  };
}
