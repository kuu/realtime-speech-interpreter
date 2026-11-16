// Candidate term extraction from plain text. Pure functions, no I/O, no dependencies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built-in stoplist (common-words.txt) plus optional extra words. */
export function loadStoplist(extraFiles = []) {
  const words = new Set();
  for (const f of [join(HERE, "common-words.txt"), ...extraFiles]) {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const w = line.trim().toLowerCase();
      if (w && !w.startsWith("#")) words.add(w);
    }
  }
  return words;
}

const SUFFIXES = ["s", "es", "ies", "ed", "d", "ing", "ly", "er", "ers", "est", "ness", "ment", "ments", "ity", "al", "ally", "ion", "ions", "able", "ize", "ized", "izing", "ization"];
/** A word is common if it, or a simple inflection of it (also stacked, like -ings), is in the stoplist. */
export function isCommon(word, stop, depth = 0) {
  const w = word.toLowerCase();
  if (stop.has(w)) return true;
  if (depth > 1) return false;
  for (const suf of SUFFIXES) {
    if (!w.endsWith(suf) || w.length - suf.length < 3) continue;
    const stem = w.slice(0, -suf.length);
    if (stop.has(stem) || stop.has(stem + "e") || stop.has(stem + "y")) return true;
    if (stem.length > 3 && stem[stem.length - 1] === stem[stem.length - 2] && stop.has(stem.slice(0, -1))) return true;
    if (isCommon(stem, stop, depth + 1)) return true;
  }
  return false;
}

/** Remove Markdown syntax and URLs; keep the words. */
export function stripMarkdownLine(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[`*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Turn file text into [{ line, text }] with the original 1-based line numbers; fenced code blocks are skipped. */
export function textItems(text, { markdown = false } = {}) {
  const items = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (markdown && /^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const t = markdown ? stripMarkdownLine(raw) : raw.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
    if (t) items.push({ line: i + 1, text: t });
  });
  return items;
}

const KIND_WEIGHT = { corrected: 95, name: 100, camelcase: 90, "letters-number": 85, acronym: 80, proper: 60, "rare-word": 20 };
const B0 = "(?<![\\p{L}\\p{N}])";
const B1 = "(?![\\p{L}\\p{N}])";
const CAP_WORD = "\\p{Lu}[\\p{L}\\p{N}]*";
const RE = {
  multi: new RegExp(`${B0}${CAP_WORD}(?: ${CAP_WORD})+${B1}`, "gu"),
  lettersNumber: new RegExp(`${B0}(?:[A-Z]{2,6}[ -]\\d+(?:[-.]\\d+)*|[A-Z]\\.\\d{3}|[A-Z][A-Za-z]*\\d[A-Za-z0-9]*)${B1}`, "gu"),
  camel: new RegExp(`${B0}[A-Za-z]*[a-z][A-Z][A-Za-z]*${B1}`, "gu"),
  acronym: new RegExp(`${B0}[A-Z]{2,8}${B1}`, "gu"),
  proper: new RegExp(`${B0}\\p{Lu}\\p{Ll}{2,}${B1}`, "gu"),
  rare: new RegExp(`${B0}[a-z]{8,}${B1}`, "gu"),
};

/**
 * Extract candidate terms.
 * @param {Array<{source: string, text: string}>} items  one per line; source is "file:line" style
 * @param {{stoplist: Set<string>, known?: Set<string>}} opts  known = lowercase terms to leave out
 * @returns {Array<{term, kind, count, source, also, score}>} sorted by score, then first appearance
 */
export function extractCandidates(items, { stoplist, known = new Set() }) {
  const found = new Map(); // key -> entry
  let order = 0;
  const add = (term, kind, source, atStart) => {
    const key = term.toLowerCase();
    let e = found.get(key);
    if (!e) {
      e = { term, kind, count: 0, source, also: [], spellings: new Map(), order: order++, nonStart: 0 };
      found.set(key, e);
    }
    e.count++;
    if (!atStart) e.nonStart++;
    e.spellings.set(term, (e.spellings.get(term) ?? 0) + 1);
    if (KIND_WEIGHT[kind] > KIND_WEIGHT[e.kind]) e.kind = kind;
    if (source !== e.source && !e.also.includes(source) && e.also.length < 4) e.also.push(source);
  };
  const common = (w) => isCommon(w, stoplist);

  for (const { source, text } of items) {
    const claimed = []; // [start, end) spans taken by a longer match
    const inside = (s, e) => claimed.some(([a, b]) => s >= a && e <= b);
    const startsSentence = (idx) => idx === 0 || /[.!?:]\s+$/.test(text.slice(0, idx)) || /^[-•*\d.)\s]*$/.test(text.slice(0, idx));
    const allCaps = text === text.toUpperCase() && /[A-Z]/.test(text);

    // 1. capitalised multi-word names (AWS Elemental MediaPackage)
    for (const m of text.matchAll(RE.multi)) {
      let words = m[0].split(" ");
      let start = m.index;
      // Drop leading common words at a sentence start ("The Elemental Live ...").
      while (words.length > 1 && startsSentence(start) && common(words[0])) {
        start += words[0].length + 1;
        words = words.slice(1);
      }
      if (words.length < 2 || allCaps || words.every((w) => /^[A-Z]{2,8}$/.test(w))) continue;
      if (words.every((w) => common(w) && !/[A-Z]{2}/.test(w))) continue;
      const term = words.join(" ");
      claimed.push([start, start + term.length]);
      add(term, "name", source, false);
    }
    // 2. letters+number patterns (ST 2110, SCTE-35, H.264, AV1, M3U8)
    for (const m of text.matchAll(RE.lettersNumber)) {
      if (inside(m.index, m.index + m[0].length)) continue;
      claimed.push([m.index, m.index + m[0].length]);
      add(m[0], "letters-number", source, false);
    }
    // 3. CamelCase (MediaPackage)
    for (const m of text.matchAll(RE.camel)) {
      if (inside(m.index, m.index + m[0].length)) continue;
      claimed.push([m.index, m.index + m[0].length]);
      add(m[0], "camelcase", source, false);
    }
    // 4. ALLCAPS acronyms (HLS, SRT)
    if (!allCaps) {
      for (const m of text.matchAll(RE.acronym)) {
        if (inside(m.index, m.index + m[0].length)) continue;
        if (m[0].length <= 3 && common(m[0])) continue;
        claimed.push([m.index, m.index + m[0].length]);
        add(m[0], "acronym", source, false);
      }
    }
    // 5. capitalised single words that are not common words (people, companies)
    for (const m of text.matchAll(RE.proper)) {
      if (inside(m.index, m.index + m[0].length) || common(m[0])) continue;
      claimed.push([m.index, m.index + m[0].length]);
      add(m[0], "proper", source, startsSentence(m.index));
    }
    // 6. rare lowercase words
    for (const m of text.matchAll(RE.rare)) {
      if (inside(m.index, m.index + m[0].length) || common(m[0])) continue;
      add(m[0], "rare-word", source, false);
    }
  }

  const out = [];
  for (const [key, e] of found) {
    if (known.has(key)) continue;
    // A capitalised word seen only at sentence starts is probably just a sentence's first word.
    if (e.kind === "proper" && e.nonStart === 0 && e.count < 2) continue;
    // Most frequent spelling wins; ties keep the first seen.
    let best = e.term;
    let bestN = 0;
    for (const [sp, n] of e.spellings) if (n > bestN) [best, bestN] = [sp, n];
    out.push({ term: best, kind: e.kind, count: e.count, source: e.source, also: e.also, order: e.order, score: KIND_WEIGHT[e.kind] + Math.min(e.count, 10) });
  }
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out;
}

/** Parse `[corrected: a -> b, c -> d]` out of a SYNTH log line. Returns [{from, to}]. */
export function parseCorrected(line) {
  const m = /\[corrected: ([^\]]*)\]/.exec(line);
  if (!m) return [];
  return m[1].split(", ").map((p) => p.split(" -> ")).filter((p) => p.length === 2).map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
}

/** Items and corrections from an app log: en="..." of COMMIT lines, and corrected words of SYNTH lines. */
export function logItems(text, label) {
  const items = [];
  const corrections = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (raw.includes(" COMMIT ")) {
      const m = /\ben="((?:[^"\\]|\\.)*)"/.exec(raw);
      if (m) items.push({ source: `${label}:${line}`, text: m[1] });
    }
    if (raw.includes(" SYNTH ")) {
      for (const c of parseCorrected(raw)) corrections.push({ ...c, source: `${label}:${line}` });
    }
  });
  return { items, corrections };
}
