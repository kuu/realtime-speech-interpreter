// Caption events: the versioned contract between the app and the listener page (docs/architecture.md).
// JSON, UTF-8, sent as reliable LiveKit data packets on topic "captions" by the publisher participant.
//
// Evolution rules: fields are only ever ADDED; consumers ignore unknown fields and unknown `type`s and
// ignore events whose `v` they do not know. `speaker` and `channel` exist today so that speaker
// detection and two-channel (bilingual) output need no breaking change.

export const CAPTION_TOPIC = "captions";
export const CAPTION_SCHEMA_VERSION = 1;
// The browser rejects longer text, so the builders truncate (on a code point boundary).
export const MAX_CAPTION_TEXT = 600;

// Japanese caption: sent when the first sample of the chunk's Japanese audio leaves the app.
export interface CaptionEventV1 {
  v: 1;
  type: "caption";
  id: string; // "<session>-<chunk seq>"
  seq: number; // monotonic across caption and source events within one app run
  session: number;
  channel: string; // "ja" today
  lang: string;
  text: string; // exactly the Japanese sent to Polly (before SSML <sub> wrapping)
  sourceLang: string;
  sourceText: string; // English text sent to translation (fillers removed, corrections applied)
  speaker: string | null; // null until speaker detection exists
  final: boolean; // always true today; later partial updates may reuse `id` with false
  startAt: number; // server epoch ms when the audio starts leaving the app (diagnostic)
  durationMs: number;
}

// English source words, as soon as the language gate and the segmenter commit them.
export interface SourceAppendEventV1 {
  v: 1;
  type: "source";
  op: "append";
  id: string;
  seq: number;
  session: number;
  resultId: string; // first 8 chars of the Transcribe ResultId (as in the logs)
  channel: string; // "en"
  lang: string;
  text: string; // words and punctuation of this batch; fillers removed; may start with punctuation
  stable: true;
  boundary: boolean; // the batch ends a sentence (.?!)
  speaker: string | null;
  audioEnd: number; // Transcribe stream seconds (diagnostic)
}

// The result turned out not to be English after its words were forwarded.
export interface SourceRetractEventV1 {
  v: 1;
  type: "source";
  op: "retract";
  seq: number;
  session: number;
  resultId: string;
  channel: string;
  lang: string;
}

export type SourceEventV1 = SourceAppendEventV1 | SourceRetractEventV1;
export type CaptionEvent = CaptionEventV1 | SourceEventV1;

export function truncateText(s: string, max = MAX_CAPTION_TEXT): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

export function buildCaptionEvent(a: {
  session: number;
  chunkSeq: number;
  seq: number;
  text: string;
  sourceText: string;
  startAt: number;
  durationMs: number;
  sourceLang?: string;
  lang?: string;
  channel?: string;
  speaker?: string | null;
}): CaptionEventV1 {
  return {
    v: CAPTION_SCHEMA_VERSION,
    type: "caption",
    id: `${a.session}-${a.chunkSeq}`,
    seq: a.seq,
    session: a.session,
    channel: a.channel ?? "ja",
    lang: a.lang ?? "ja",
    text: truncateText(a.text),
    sourceLang: a.sourceLang ?? "en",
    sourceText: truncateText(a.sourceText),
    speaker: a.speaker ?? null,
    final: true,
    startAt: a.startAt,
    durationMs: a.durationMs,
  };
}

export function buildSourceAppend(a: {
  session: number;
  n: number;
  seq: number;
  resultId: string;
  text: string;
  boundary: boolean;
  audioEnd: number;
  lang?: string;
  channel?: string;
  speaker?: string | null;
}): SourceAppendEventV1 {
  return {
    v: CAPTION_SCHEMA_VERSION,
    type: "source",
    op: "append",
    id: `${a.session}-${a.n}`,
    seq: a.seq,
    session: a.session,
    resultId: a.resultId,
    channel: a.channel ?? "en",
    lang: a.lang ?? "en",
    text: truncateText(a.text),
    stable: true,
    boundary: a.boundary,
    speaker: a.speaker ?? null,
    audioEnd: a.audioEnd,
  };
}

export function buildSourceRetract(a: { session: number; seq: number; resultId: string }): SourceRetractEventV1 {
  return {
    v: CAPTION_SCHEMA_VERSION,
    type: "source",
    op: "retract",
    seq: a.seq,
    session: a.session,
    resultId: a.resultId,
    channel: "en",
    lang: "en",
  };
}

// JSON.stringify escapes only JSON syntax: no HTML escaping, no entity conversion. The page renders
// the text with textContent, so '<script>' stays plain characters.
export function encodeCaptionEvent(ev: CaptionEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ev));
}
