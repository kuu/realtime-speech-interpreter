// Filler removal so hesitations are never translated or spoken (e.g. "um" → "ええと",
// "you know" → "ご存知のとおり"). Two layers, both pure functions:
//   1. English, before Translate:
//      - filler WORDS (um, uh, ...) are always removed (whole words only);
//      - filler PHRASES (you know, I mean, well, like, ...) are removed only when used as
//        discourse markers: at the start of the chunk/sentence and followed by a comma or
//        nothing, or set off by commas (", you know," / ", you know." at the end).
//        Literal uses survive: "do you know", "works well", "I'd like", "this kind of feature".
//   2. Japanese, after Translate (safety net): patterns are stripped only at the start of
//      the text or right after 。/、, and only when followed by 、/。/!/?/space/end
//      (never mid-word, so "あのサービス" keeps its demonstrative). A pattern ending in
//      "、" (e.g. "つまり、") only matches at the start of a sentence.

export interface FilterResult {
  text: string;
  removed: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Collapse whitespace and fix punctuation left behind by removals.
function cleanupEnglish(s: string): string {
  let t = s.replace(/\s+/g, " ");
  t = t.replace(/\s+([,.?!;:])/g, "$1"); // "foo ," → "foo,"
  t = t.replace(/,(\s*,)+/g, ","); // ",," → ","
  t = t.replace(/,\s*([.?!;:])/g, "$1"); // ", ." → "."
  t = t.replace(/([.?!])\s*,/g, "$1"); // ". ," → "."
  t = t.replace(/^[\s,;:]+/, ""); // leading comma
  return t.trim();
}

export function hasWords(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

export function filterEnglish(
  text: string,
  fillerWords: readonly string[],
  fillerPhrases: readonly string[],
): FilterResult {
  const removed: string[] = [];
  let t = text;

  const words = [...fillerWords].map((w) => w.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (words.length > 0) {
    // Whole word only (no letters, digits, apostrophes or hyphens adjacent), plus one trailing comma.
    const re = new RegExp(`(?<![\\p{L}\\p{N}'-])(${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}'-])\\s*,?`, "giu");
    t = t.replace(re, (_m, w: string) => {
      removed.push(w.toLowerCase());
      return " ";
    });
    t = cleanupEnglish(t);
  }

  const phrases = [...fillerPhrases].map((p) => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (phrases.length > 0) {
    const alt = phrases.map((p) => escapeRe(p).replace(/\s+/g, "\\s+")).join("|");
    // a) start of text or sentence, followed by a comma, sentence end, or end of text.
    const startRe = new RegExp(`(^|[.?!]\\s+)(${alt})(?:\\s*,|(?=\\s*[.?!])|\\s*$)`, "iu");
    // b) set off by commas: ", X," → ","  and ", X." / ", X" at the end → "".
    const midRe = new RegExp(`,\\s*(${alt})\\s*(,|(?=[.?!])|$)`, "iu");
    for (let guard = 0; guard < 50; guard++) {
      let m = startRe.exec(t);
      if (m) {
        removed.push(m[2].toLowerCase().replace(/\s+/g, " "));
        t = cleanupEnglish(t.slice(0, m.index) + m[1] + t.slice(m.index + m[0].length));
        continue;
      }
      m = midRe.exec(t);
      if (m) {
        removed.push(m[1].toLowerCase().replace(/\s+/g, " "));
        const keep = m[2] === "," ? "," : "";
        t = cleanupEnglish(t.slice(0, m.index) + keep + " " + t.slice(m.index + m[0].length));
        continue;
      }
      break;
    }
  }
  return { text: cleanupEnglish(t), removed };
}

export function filterJapanese(text: string, patterns: readonly string[]): FilterResult {
  const removed: string[] = [];
  let t = text.trim();
  const pats = [...patterns].map((p) => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (pats.length === 0) return { text: t, removed };
  const sentenceOnly = pats.filter((p) => p.endsWith("、")).map(escapeRe);
  const general = pats.filter((p) => !p.endsWith("、")).map(escapeRe);
  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    if (sentenceOnly.length > 0) {
      const re = new RegExp(`(^|[。！？!?]\\s*)(${sentenceOnly.join("|")})\\s*`, "u");
      const m = re.exec(t);
      if (m) {
        removed.push(m[2]);
        t = t.slice(0, m.index) + m[1] + t.slice(m.index + m[0].length);
        changed = true;
      }
    }
    if (!changed && general.length > 0) {
      // Boundary before; delimiter (or end) after. A following 、 is removed with it.
      const re = new RegExp(`(^|[。、！？!?]\\s*)(${general.join("|")})(、|\\s+|(?=[。！？!?])|$)`, "u");
      const m = re.exec(t);
      if (m) {
        removed.push(m[2]);
        t = t.slice(0, m.index) + m[1] + t.slice(m.index + m[0].length);
        changed = true;
      }
    }
    if (!changed) break;
  }
  t = t.replace(/、{2,}/g, "、").replace(/、(?=[。！？!?])/g, "").replace(/^[、。\s]+/, "").replace(/。、/g, "。");
  return { text: t.trim(), removed };
}
