// Post-recognition corrections for known confusions that custom vocabulary cannot
// fully fix (a wrong word that is itself valid English, or a term Transcribe drops
// under Opus). Applied to the recognized English text before translation.
//
// Two kinds of rules:
//   - plain word rules (`corrections`): always replaced, case-insensitive.
//   - context rules (`contextRules`): replaced only when the surrounding words
//     support it, so ordinary uses ("ABC News", "lunch break", "wrist watch") are
//     never touched. Keep every rule conservative: a missed fix costs little, a wrong
//     fix changes the meaning.
interface Correction {
  wrong: string;
  right: string;
}
const corrections: Correction[] = [
  { wrong: "fertilization", right: "verticalization" },
  { wrong: "fertilize", right: "verticalize" },
  { wrong: "fertilized", right: "verticalized" },
];

interface Token {
  w: string;
  start: number;
}
interface ContextRule {
  label: string; // logged as `wrong -> right`
  pattern: RegExp; // global; matched against the text
  // Returns the replacement for one match, or null to leave it unchanged.
  replace: (match: string, tokens: Token[], i: number, text: string) => string | null;
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z0-9]+(?:[.'\-][A-Za-z0-9]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ w: m[0], start: m.index });
  return out;
}
function around(tokens: Token[], i: number, n: number): string[] {
  return [...tokens.slice(Math.max(0, i - n), i), ...tokens.slice(i + 1, i + 1 + n)].map((t) => t.w);
}
function before(tokens: Token[], i: number, n: number): string[] {
  return tokens.slice(Math.max(0, i - n), i).map((t) => t.w);
}
function after(tokens: Token[], i: number, n: number): string[] {
  return tokens.slice(i + 1, i + 1 + n).map((t) => t.w);
}
function matchCase(src: string, word: string): string {
  if (src === src.toUpperCase() && src.length > 1) return word.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

const CODEC_CONTEXT =
  /\b(?:HEVC|H\.264|H\.265|codecs?|encode[ds]?|encoding|transcode[ds]?|transcoding)\b/i;
const BROADCASTER_GUARD = new Set(
  ["nbc", "cbs", "fox", "news", "network", "television", "tv", "australia", "disney", "corporation", "studios"],
);
const PROTOCOLS = new Set(["srt", "rtp", "rtmp", "zixi", "rist", "hls", "webrtc", "ndi", "xixi", "zxixi"]);
const WRIST_GUARD = new Set(["watch", "band", "strap"]);
// "lunch" -> "launch" only in two narrow shapes: "at lunch ... support/add/introduce ..." (a roadmap
// sentence) and "lunch of the new ...". Broad product words (available, services, channels) are NOT enough.
const LAUNCH_VERBS = /^(?:support|supports|supported|supporting|add|adds|added|introduce|introduces|introduced|announce|announced|announces)$/i;
const LAUNCH_OF_NEW = /^of\s+(?:the|our|a)\s+new\b/i;
const MEAL_WORDS =
  /\b(?:break|hour|food|eat|eating|menu|served|buffet|bento|coffee|reception|networking|room|tomorrow|today|before|after|join us|restaurant|dinner|breakfast)\b/i;

// Order matters: HEBC first so the ABC rule sees HEVC.
const contextRules: ContextRule[] = [
  { label: "HEBC -> HEVC", pattern: /\bHEBC\b/g, replace: () => "HEVC" },
  {
    label: "ABC -> AVC",
    pattern: /\bABC\b/g,
    replace: (_m, tokens, i) => {
      if (!CODEC_CONTEXT.test(around(tokens, i, 4).join(" "))) return null;
      if (around(tokens, i, 2).some((w) => BROADCASTER_GUARD.has(w.toLowerCase()))) return null;
      return "AVC";
    },
  },
  { label: "Xixi -> Zixi", pattern: /\b(?:ZXixi|Xixi)\b/g, replace: () => "Zixi" },
  {
    label: "wrist -> RIST",
    pattern: /\bwrist\b/gi,
    replace: (_m, tokens, i) => {
      const next = after(tokens, i, 1)[0];
      if (next && WRIST_GUARD.has(next.toLowerCase())) return null;
      const isProto = (w: string) => PROTOCOLS.has(w.toLowerCase());
      if (before(tokens, i, 2).some(isProto) && after(tokens, i, 2).some(isProto)) return "RIST";
      return null;
    },
  },
  {
    label: "lunch -> launch",
    pattern: /\blunch\b/gi,
    replace: (m, tokens, i, text) => {
      if (MEAL_WORDS.test(text)) return null;
      const prev = before(tokens, i, 1)[0];
      const atLaunch = prev !== undefined && prev.toLowerCase() === "at" && after(tokens, i, 5).some((w) => LAUNCH_VERBS.test(w));
      const lunchOfNew = LAUNCH_OF_NEW.test(text.slice(tokens[i].start + m.length).trimStart());
      return atLaunch || lunchOfNew ? matchCase(m, "launch") : null;
    },
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function applyCorrections(text: string): { text: string; applied: string[] } {
  let result = text;
  const applied: string[] = [];
  for (const rule of contextRules) {
    const src = result;
    const tokens = tokenize(src);
    let changed = false;
    result = src.replace(rule.pattern, (m, ...rest) => {
      const offset = rest[rest.length - 2] as number;
      const i = tokens.findIndex((t) => t.start === offset);
      if (i < 0) return m;
      const r = rule.replace(m, tokens, i, src);
      if (r === null) return m;
      changed = true;
      return r;
    });
    if (changed) applied.push(rule.label);
  }
  for (const { wrong, right } of corrections) {
    const re = new RegExp(`\\b${escapeRegExp(wrong)}\\b`, "gi");
    if (re.test(result)) {
      result = result.replace(re, right);
      applied.push(`${wrong} -> ${right}`);
    }
  }
  return { text: result, applied };
}
