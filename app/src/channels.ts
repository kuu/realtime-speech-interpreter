// Output channels (lanes) of one deploy: parsed from CHANNELS (two lanes) or from the flat variables (one lane, today's
// behaviour). Pure over an env object so the same rules are unit-tested, and shared with the CDK validation through
// test/fixtures/channels-cases.json. No dictionary default is applied here: CDK writes the resolved names (design:
// "Dictionary defaults follow the direction").
export type LaneEngine = "translate" | "llm";
export interface ChannelSpec {
  source: string; // Transcribe code of the speech this lane translates, e.g. en-US
  target: string; // Translate code of the lane's listeners; also the channel id (ja, en)
  pollyVoice: string;
  transcribeVocabulary: string;
  translateTerminology: string;
  translateEngine?: LaneEngine; // absent = the global TRANSLATE_ENGINE
  translateSource?: string; // flat variables only (TRANSLATE_SOURCE); absent = the language prefix of source
}
export interface ChannelsContext {
  languageOptions: readonly string[];
  languageFilter: "off" | "langid";
  translateEngine: LaneEngine; // global default
}
export class ChannelsError extends Error {}

const KEYS = ["source", "target", "pollyVoice", "transcribeVocabulary", "translateTerminology", "translateEngine"] as const;
const SOURCE_CODE = /^[a-z]{2,3}-[A-Z]{2}$/;
const TARGET_ID = /^[a-z]{2,3}$/;
export const DEFAULT_LANGUAGE_OPTIONS = ["en-US", "ja-JP"];

function fail(msg: string): never {
  throw new ChannelsError(`CHANNELS: ${msg}`);
}
const prefixOf = (code: string): string => code.split("-")[0].toLowerCase();

// Validates and normalises a list of lanes (1 or 2). Throws ChannelsError naming the lane (1-based) and the rule.
export function validateChannels(raw: unknown, ctx: ChannelsContext): ChannelSpec[] {
  if (!Array.isArray(raw)) fail("must be a JSON list of lanes");
  if (raw.length < 1 || raw.length > 2) fail(`needs 1 to 2 lanes, got ${raw.length}`);
  const lanes: ChannelSpec[] = raw.map((e, i) => {
    const n = i + 1;
    if (e === null || typeof e !== "object" || Array.isArray(e)) fail(`lane ${n} must be an object`);
    const o = e as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!(KEYS as readonly string[]).includes(k)) fail(`lane ${n} has an unknown key "${k}"`);
    const text = (k: (typeof KEYS)[number], required: boolean): string => {
      const v = o[k];
      if (v === undefined) {
        if (required) fail(`lane ${n} needs "${k}"`);
        return "";
      }
      if (typeof v !== "string") fail(`lane ${n} "${k}" must be a string`);
      const t = v.trim();
      if (required && t === "") fail(`lane ${n} needs "${k}"`);
      return t;
    };
    const source = text("source", true);
    const target = text("target", true);
    const pollyVoice = text("pollyVoice", true);
    if (!SOURCE_CODE.test(source)) fail(`lane ${n} source "${source}" is not a Transcribe code like en-US`);
    if (!ctx.languageOptions.includes(source)) fail(`lane ${n} source "${source}" is not in languageOptions (${ctx.languageOptions.join(",")})`);
    if (!TARGET_ID.test(target)) fail(`lane ${n} target "${target}" must match ^[a-z]{2,3}$`);
    if (target === prefixOf(source)) fail(`lane ${n} translates ${source} into the same language "${target}"`);
    const eng = o.translateEngine;
    if (eng !== undefined && eng !== "translate" && eng !== "llm") fail(`lane ${n} translateEngine must be "translate" or "llm"`);
    const spec: ChannelSpec = {
      source,
      target,
      pollyVoice,
      transcribeVocabulary: text("transcribeVocabulary", false),
      translateTerminology: text("translateTerminology", false),
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

function envList(v: string | undefined, def: readonly string[]): string[] {
  if (v === undefined || v.trim() === "") return [...def];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// Lanes of this deploy. CHANNELS absent or empty: one lane from the flat variables, no validation (today's behaviour,
// including today's defaults). CHANNELS present: parsed and validated; an invalid list throws.
export function parseChannels(env: NodeJS.ProcessEnv): ChannelSpec[] {
  const engineRaw = (env.TRANSLATE_ENGINE ?? "").trim().toLowerCase();
  const globalEngine: LaneEngine = engineRaw === "llm" ? "llm" : "translate";
  const raw = env.CHANNELS;
  if (raw === undefined || raw.trim() === "") {
    const lane: ChannelSpec = {
      source: env.SOURCE_LANGUAGE ?? "en-US",
      target: env.TRANSLATE_TARGET ?? "ja",
      pollyVoice: env.POLLY_VOICE ?? "Kazuha",
      transcribeVocabulary: env.TRANSCRIBE_VOCABULARY ?? "",
      translateTerminology: env.TRANSLATE_TERMINOLOGY ?? "",
      translateSource: env.TRANSLATE_SOURCE ?? (env.SOURCE_LANGUAGE ? prefixOf(env.SOURCE_LANGUAGE) : "en"),
    };
    return [lane];
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail("is not valid JSON");
  }
  const filterRaw = (env.LANGUAGE_FILTER ?? "").trim().toLowerCase();
  return validateChannels(json, {
    languageOptions: envList(env.LANGUAGE_OPTIONS, DEFAULT_LANGUAGE_OPTIONS),
    languageFilter: filterRaw === "off" ? "off" : "langid",
    translateEngine: globalEngine,
  });
}
