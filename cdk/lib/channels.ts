// Output channels (lanes) of one deploy: normalise and validate the `channels` setting. Mirrors app/src/channels.ts
// (same rules, same messages); both are tested against app/test/fixtures/channels-cases.json so they cannot drift.
// CDK also resolves the dictionary names by direction (the app never applies defaults) and writes the result into
// the container environment: flat variables for one lane, CHANNELS (JSON) for two.
export type LaneEngine = "translate" | "llm";
export interface LaneSpec {
  source: string; // Transcribe code, e.g. en-US
  target: string; // Translate code and channel id, e.g. ja
  pollyVoice: string;
  transcribeVocabulary: string;
  translateTerminology: string;
  translateEngine?: LaneEngine; // absent = the global translateEngine
}
export interface ChannelsContext {
  languageOptions: readonly string[];
  languageFilter: string;
  translateEngine: string; // global
  // Names a lane with source en-US and target ja takes by default (dictionaries.transcribeVocabulary / translateTerminology).
  dictVocabulary?: string;
  dictTerminology?: string;
}
export class ChannelsError extends Error {}

const KEYS = ["source", "target", "pollyVoice", "transcribeVocabulary", "translateTerminology", "translateEngine"] as const;
const SOURCE_CODE = /^[a-z]{2,3}-[A-Z]{2}$/;
const TARGET_ID = /^[a-z]{2,3}$/;
const prefixOf = (code: string): string => code.split("-")[0].toLowerCase();
function fail(msg: string): never {
  throw new ChannelsError(`channels: ${msg}`);
}

export const isDefaultLane = (l: Pick<LaneSpec, "source" | "target">): boolean => l.source === "en-US" && l.target === "ja";

/** Accepts the setting as a JSON text (-c channels='[...]') or an already parsed list. */
export function parseChannelsSetting(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fail("is not valid JSON");
  }
}

/**
 * Applies the dictionary defaults by direction (only en-US to ja takes dictionaries.*, every other lane defaults to
 * ""), then validates. Throws ChannelsError naming the lane (1-based) and the rule.
 */
export function resolveChannels(raw: unknown, ctx: ChannelsContext): LaneSpec[] {
  if (!Array.isArray(raw)) fail("must be a JSON list of lanes");
  if (raw.length < 1 || raw.length > 2) fail(`needs 1 to 2 lanes, got ${raw.length}`);
  const lanes: LaneSpec[] = raw.map((e, i) => {
    const n = i + 1;
    if (e === null || typeof e !== "object" || Array.isArray(e)) fail(`lane ${n} must be an object`);
    const o = e as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) fail(`lane ${n} has an unknown key "${k}"`);
    const text = (k: (typeof KEYS)[number], required: boolean): string | undefined => {
      const v = o[k];
      if (v === undefined) {
        if (required) fail(`lane ${n} needs "${k}"`);
        return undefined;
      }
      if (typeof v !== "string") fail(`lane ${n} "${k}" must be a string`);
      const t = v.trim();
      if (required && t === "") fail(`lane ${n} needs "${k}"`);
      return t;
    };
    const source = text("source", true) as string;
    const target = text("target", true) as string;
    const pollyVoice = text("pollyVoice", true) as string;
    if (!SOURCE_CODE.test(source)) fail(`lane ${n} source "${source}" is not a Transcribe code like en-US`);
    if (!ctx.languageOptions.includes(source)) fail(`lane ${n} source "${source}" is not in languageOptions (${ctx.languageOptions.join(",")})`);
    if (!TARGET_ID.test(target)) fail(`lane ${n} target "${target}" must match ^[a-z]{2,3}$`);
    if (target === prefixOf(source)) fail(`lane ${n} translates ${source} into the same language "${target}"`);
    const eng = o.translateEngine;
    if (eng !== undefined && eng !== "translate" && eng !== "llm") fail(`lane ${n} translateEngine must be "translate" or "llm"`);
    // Dictionary defaults follow the direction, not the position. The Translate terminology is one multi-directional
    // resource: every lane defaults to it. The Transcribe vocabulary is English: only the en to ja lane defaults to it.
    const dflt = isDefaultLane({ source, target });
    const spec: LaneSpec = {
      source,
      target,
      pollyVoice,
      transcribeVocabulary: text("transcribeVocabulary", false) ?? (dflt ? (ctx.dictVocabulary ?? "") : ""),
      translateTerminology: text("translateTerminology", false) ?? (ctx.dictTerminology ?? ""),
    };
    if (eng !== undefined) spec.translateEngine = eng;
    return spec;
  });
  if (new Set(lanes.map((l) => l.source)).size !== lanes.length) fail("lane sources must be distinct");
  if (new Set(lanes.map((l) => l.target)).size !== lanes.length) fail("lane targets must be distinct");
  if (lanes.length === 2 && ctx.languageFilter !== "langid") fail("two lanes need languageFilter=langid");
  lanes.forEach((l, i) => {
    if ((l.translateEngine ?? ctx.translateEngine) === "llm" && l.translateTerminology === "") {
      fail(`lane ${i + 1} (${l.source} to ${l.target}) uses the llm engine and needs translateTerminology`);
    }
  });
  return lanes;
}

/** The value of the CHANNELS environment variable (two lanes only): stable key order, no default left to the app. */
export function channelsEnv(lanes: readonly LaneSpec[]): string {
  return JSON.stringify(
    lanes.map((l) => ({
      source: l.source,
      target: l.target,
      pollyVoice: l.pollyVoice,
      transcribeVocabulary: l.transcribeVocabulary,
      translateTerminology: l.translateTerminology,
      ...(l.translateEngine ? { translateEngine: l.translateEngine } : {}),
    })),
  );
}

export interface ListenerChannel {
  id: string;
  sourceLang: string;
  targetLang: string;
  track: string;
  publisher: string;
  topic: string;
}
/** config.json `channels`: LiveKit names per lane. The first lane keeps the legacy names. */
export function listenerChannels(lanes: readonly LaneSpec[]): ListenerChannel[] {
  return lanes.map((l, i) => ({
    id: l.target,
    sourceLang: prefixOf(l.source),
    targetLang: l.target,
    track: i === 0 ? "translation-audio" : `translation-audio-${l.target}`,
    publisher: i === 0 ? "publisher-app" : `publisher-app-${l.target}`,
    topic: i === 0 ? "captions" : `captions-${l.target}`,
  }));
}

/**
 * The channel fields of config.json: only when the `channels` setting is used for two lanes or one non-default lane.
 * Without them the page assumes the default (Japanese) channel, as today.
 */
export function listenerConfigFields(cfg: { channelsUsed: boolean; twoLanes: boolean; lanes: readonly LaneSpec[] }): {
  defaultChannel?: string;
  channels?: ListenerChannel[];
} {
  if (!cfg.channelsUsed || !(cfg.twoLanes || !isDefaultLane(cfg.lanes[0]))) return {};
  return { defaultChannel: cfg.lanes[0].target, channels: listenerChannels(cfg.lanes) };
}
