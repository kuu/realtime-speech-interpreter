// Output validation for the LLM engine. The prompt asks for Japanese only, but the benchmark showed
// models leaking English meta-text on injection-style chunks, so validation (not the prompt) is the
// guard before Polly. Pure. Rules are applied in order; the first failure wins.
import type { GlossaryEntry } from "./glossary.js";
import { countWords } from "./llm-prompt.js";

export type ValidationRule =
  | "empty"
  | "multiline"
  | "tag"
  | "prefix"
  | "markdown"
  | "not-japanese"
  | "english-run"
  | "too-short"
  | "too-long";

export type ValidationResult = { ok: true; text: string } | { ok: false; rule: ValidationRule; detail: string };

export interface ValidateOptions {
  source: string; // the English text actually sent
  glossary: readonly GlossaryEntry[];
  maxCharsPerWord: number;
}

const TAG_RE = /<\/?[A-Za-z][^>]*>/;
const LABEL_PREFIX_RE = /^(翻訳|訳|日本語訳?|和訳|JA|Japanese|Translation|Translated|Output|Answer|回答)\s*[:：]/i;
const META_PREFIX_RE =
  /^(here is|here's|sure|certainly|of course|i'm|i am|i will|i'll|i'd|i can't|i cannot|i appreciate|sorry|note\s*:|this is)(?![A-Za-z])/i;
const MARKDOWN_RE = /```|`|\*\*|^(#+|>|[-*]\s|\d+\.\s)/;
const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["\u201C", "\u201D"],
  ["'", "'"],
  ["\u2018", "\u2019"],
  ["\u300C", "\u300D"],
];
const JA_CHAR_RE = /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uFF66-\uFF9F\u3005\u30FC]/g;
const LATIN_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.'\u2019+/-]*/g;
const ACRONYM_RE = /^[A-Z0-9][A-Z0-9.+/-]+$/;

function stripToken(t: string): string {
  return t.replace(/[.'\u2019+/-]+$/, "");
}

interface Tok {
  text: string; // trailing punctuation removed
  start: number;
  end: number;
}
function latinTokens(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(LATIN_TOKEN_RE)) {
    const text = stripToken(m[0]);
    if (text) out.push({ text, start: m.index!, end: m.index! + text.length });
  }
  return out;
}

function addTokenForms(set: Set<string>, token: string): void {
  const lower = token.toLowerCase();
  set.add(lower);
  for (const part of lower.split(/[-/]/)) if (part) set.add(part);
}

export function allowedLatinSet(source: string, glossary: readonly GlossaryEntry[]): Set<string> {
  const set = new Set<string>();
  for (const t of latinTokens(source)) addTokenForms(set, t.text);
  for (const [en, ja] of glossary) {
    for (const t of latinTokens(en)) addTokenForms(set, t.text);
    for (const t of latinTokens(ja)) addTokenForms(set, t.text);
  }
  return set;
}

function isProductLike(t: string): boolean {
  if (ACRONYM_RE.test(t) && t.length >= 2) return true;
  if (/\d/.test(t)) return true;
  if (/^[A-Z][a-z0-9]+[A-Z]/.test(t) || /[a-z][A-Z]/.test(t)) return true; // MediaLive, iPhone
  return false;
}

function isAllowed(t: string, allowed: Set<string>): boolean {
  const lower = t.toLowerCase();
  if (allowed.has(lower)) return true;
  if (isProductLike(t)) return true;
  const parts = lower.split(/[-/]/).filter(Boolean);
  return parts.length > 1 && parts.every((p) => allowed.has(p));
}

function stripWrappingQuotes(s: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      const inner = s.slice(open.length, s.length - close.length);
      if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
    }
  }
  return s;
}

function charCount(s: string): number {
  return s.replace(/[\s\u3000、。,.，．]/g, "").length;
}

function clip(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export function validateLlmOutput(raw: string, o: ValidateOptions): ValidationResult {
  const words = countWords(o.source);
  let text = raw.trim();
  const fail = (rule: ValidationRule, detail: string): ValidationResult => ({ ok: false, rule, detail });

  if (text === "") return words > 0 ? fail("empty", "no output for a chunk with words") : { ok: true, text };
  if (/[\n\r]/.test(text)) return fail("multiline", clip(text.replace(/\s+/g, " ")));
  const tag = TAG_RE.exec(text);
  if (tag) return fail("tag", tag[0]);
  // Prompt v2 field name echoed without angle brackets.
  if (/chunk_ends_sentence/i.test(text)) return fail("tag", "chunk_ends_sentence");
  if (LABEL_PREFIX_RE.test(text) || META_PREFIX_RE.test(text)) return fail("prefix", clip(text, 40));
  if (MARKDOWN_RE.test(text)) return fail("markdown", clip(text, 40));

  text = stripWrappingQuotes(text);
  if (text === "") return words > 0 ? fail("empty", "only quotes") : { ok: true, text };

  const allowed = allowedLatinSet(o.source, o.glossary);
  const glossaryOnly = allowedLatinSet("", o.glossary);
  const toks = latinTokens(text);
  const jaChars = (text.match(JA_CHAR_RE) ?? []).length;
  const bad = toks.filter((t) => !isAllowed(t.text, allowed));
  const badLetters = bad.reduce((n, t) => n + (t.text.match(/[A-Za-z]/g) ?? []).length, 0);
  if (jaChars === 0) {
    // A Latin-only output is accepted only for names (acronyms, CamelCase, digits, glossary terms),
    // never for plain English words that merely appear in the source (that is an untranslated copy).
    const onlyNames = toks.length > 0 && toks.length <= 4 && toks.every((t) => isProductLike(t.text) || glossaryOnly.has(t.text.toLowerCase()));
    const onlyAllowedLatin = onlyNames && bad.length === 0;
    const rest = text.replace(LATIN_TOKEN_RE, "").replace(/[\s\u3000、。,.，．!?！？:：;；()（）/\-+'"]/g, "");
    if (!(onlyAllowedLatin && rest === "")) return fail("not-japanese", `no Japanese characters: ${clip(text, 40)}`);
  } else if (jaChars / (jaChars + badLetters) < 0.7) {
    return fail("not-japanese", `ja=${jaChars} latin=${badLetters}: ${clip(text, 40)}`);
  }

  // 3+ consecutive Latin words (separated by spaces only) that are not in the source or glossary.
  let run = 0;
  let runStart = "";
  let prevEnd = -1;
  for (const t of toks) {
    const adjacent = prevEnd >= 0 && /^[ \u3000]+$/.test(text.slice(prevEnd, t.start));
    if (!isAllowed(t.text, allowed)) {
      if (adjacent && run > 0) run++;
      else {
        run = 1;
        runStart = t.text;
      }
      if (run >= 3) return fail("english-run", `${clip(runStart, 30)} ...`);
    } else run = 0;
    prevEnd = t.end;
  }

  const n = charCount(text);
  const minChars = Math.max(1, Math.floor(0.4 * words));
  const maxChars = Math.ceil(o.maxCharsPerWord * words) + 10;
  if (n < minChars) return fail("too-short", `${n} chars < ${minChars} for ${words} words`);
  if (n > maxChars) return fail("too-long", `${n} chars > ${maxChars} for ${words} words`);
  return { ok: true, text };
}
