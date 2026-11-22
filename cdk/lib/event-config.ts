import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Layered configuration. Precedence, highest first:
//   1. explicit -c key=value       (a value that differs from the one in cdk.json)
//   2. config/event.json           (friendly event settings, see docs/configuration.md)
//   3. a profile                   (config/profiles/<name>.json, chosen with -c latencyPreset or event "profile")
//   4. cdk.json "context"          (shipped defaults)

export const CDK_DIR = join(__dirname, "..");
export const CONFIG_DIR = join(CDK_DIR, "config");
export const DEFAULT_EVENT_FILE = join(CONFIG_DIR, "event.json");

export type Layer = Record<string, unknown>;

/** Old preset names that keep working. "fast" is the talk timing bundle WITHOUT the engine switch. */
export const PROFILE_ALIASES: Record<string, { profile: string; omit?: string[] }> = {
  fast: { profile: "talk", omit: ["translateEngine"] },
  default: { profile: "careful" },
};

/** Top-level keys of event.json (everything else belongs in "advanced"). */
export const EVENT_KEYS = [
  "venueCidr",
  "region",
  "profile",
  "sourceLanguage",
  "targetLanguage",
  "pollyVoice",
  "channels",
  "pollyReadings",
  "translateEngine",
  "llmModelId",
  "dictionaries",
  "expectedListeners",
  "advanced",
] as const;

/** expectedListeners -> LiveKit instance type. An estimate, not load-tested (see docs/configuration.md). */
export const LISTENER_TIERS: Array<{ upTo: number; instanceType: string }> = [
  { upTo: 300, instanceType: "c6i.large" },
  { upTo: 1000, instanceType: "c6i.xlarge" },
  { upTo: 3000, instanceType: "c6i.2xlarge" },
];

export function cdkJsonContext(): Layer {
  try {
    const raw = JSON.parse(readFileSync(join(CDK_DIR, "cdk.json"), "utf8")) as { context?: Layer };
    return raw.context ?? {};
  } catch (err) {
    throw new Error(`cannot read cdk.json next to lib/ (${String(err)})`);
  }
}

/** Keys that may be set from event.json "advanced" and from profiles: every non-CDK-flag key of cdk.json. */
export function knownContextKeys(): string[] {
  return Object.keys(cdkJsonContext()).filter((k) => !k.startsWith("@aws-cdk/"));
}

/** Parse JSON that may contain // line comments and /* block comments *\/ (strings are respected). */
export function parseJsonc(text: string, where: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`${where}: invalid JSON (${String(err)})`);
  }
}

export function listProfiles(): string[] {
  return readdirSync(join(CONFIG_DIR, "profiles"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function profileNames(): string[] {
  return [...listProfiles(), ...Object.keys(PROFILE_ALIASES)];
}

/** Context values of a profile (alias-aware). Throws on an unknown name or an unknown key in the file. */
export function loadProfile(name: string): Layer {
  const alias = PROFILE_ALIASES[name];
  const file = alias ? alias.profile : name;
  if (!listProfiles().includes(file)) {
    throw new Error(`latencyPreset/profile must be one of: ${profileNames().join(", ")} (got "${name}")`);
  }
  const path = join(CONFIG_DIR, "profiles", `${file}.json`);
  const raw = parseJsonc(readFileSync(path, "utf8"), path) as { context?: Layer };
  const known = new Set(knownContextKeys());
  const ctx: Layer = {};
  for (const [k, v] of Object.entries(raw.context ?? {})) {
    if (!known.has(k)) throw new Error(`${path}: unknown key "${k}" in "context"`);
    if (!(alias?.omit ?? []).includes(k)) ctx[k] = v;
  }
  return ctx;
}

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

/** Map the friendly event.json onto context keys. Validates names and types, not values (loadConfig does that). */
export function eventToContext(ev: unknown, path: string): Layer {
  if (typeof ev !== "object" || ev === null || Array.isArray(ev)) fail(path, "must be a JSON object");
  const e = ev as Record<string, unknown>;
  const allowed = new Set<string>(EVENT_KEYS);
  for (const k of Object.keys(e)) {
    if (!allowed.has(k)) fail(path, `unknown key "${k}". Allowed: ${EVENT_KEYS.join(", ")}. Other settings go under "advanced".`);
  }
  const out: Layer = {};
  const str = (k: string): string => {
    if (typeof e[k] !== "string") fail(path, `"${k}" must be a string`);
    return e[k] as string;
  };
  if (e.venueCidr !== undefined) {
    const v = e.venueCidr;
    if (!(typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")))) {
      fail(path, '"venueCidr" must be a string or a list of strings');
    }
    out.venueCidr = Array.isArray(v) ? v.join(",") : v;
  }
  if (e.region !== undefined) out.region = str("region");
  if (e.profile !== undefined) out.latencyPreset = str("profile");
  if (e.sourceLanguage !== undefined) {
    out.sourceLanguage = str("sourceLanguage");
    out.translateSource = (out.sourceLanguage as string).split("-")[0];
  }
  if (e.targetLanguage !== undefined) out.translateTarget = str("targetLanguage");
  if (e.pollyVoice !== undefined) out.pollyVoice = str("pollyVoice");
  if (e.channels !== undefined) {
    // One or two lanes; validated by lib/channels.ts. It replaces the flat language and voice keys, so both are rejected.
    if (!Array.isArray(e.channels)) fail(path, '"channels" must be a list of one or two lanes');
    for (const flat of ["sourceLanguage", "targetLanguage", "pollyVoice"]) {
      if (e[flat] !== undefined) fail(path, `"channels" cannot be combined with "${flat}": put the language and voice in each channel instead`);
    }
    out.channels = e.channels;
  }
  if (e.pollyReadings !== undefined) {
    if (typeof e.pollyReadings !== "boolean") fail(path, '"pollyReadings" must be true or false');
    out.pollyReadings = e.pollyReadings ? "on" : "off";
  }
  if (e.translateEngine !== undefined) out.translateEngine = str("translateEngine");
  if (e.llmModelId !== undefined) out.llmModelId = str("llmModelId");
  if (e.dictionaries !== undefined) {
    const d = e.dictionaries as Record<string, unknown>;
    if (typeof d !== "object" || d === null || Array.isArray(d)) fail(path, '"dictionaries" must be an object');
    for (const k of Object.keys(d)) {
      if (k !== "transcribeVocabulary" && k !== "translateTerminology" && k !== "dir") {
        fail(path, `unknown key "dictionaries.${k}" (use transcribeVocabulary, translateTerminology, dir)`);
      }
      if (typeof d[k] !== "string") fail(path, `"dictionaries.${k}" must be a string ("" disables it)`);
    }
    if (d.transcribeVocabulary !== undefined) out.transcribeVocabularyName = d.transcribeVocabulary;
    if (d.translateTerminology !== undefined) out.translateTerminologyName = d.translateTerminology;
    if (d.dir !== undefined) out.dictionaryDir = d.dir;
  }
  if (e.expectedListeners !== undefined) {
    const n = e.expectedListeners;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) fail(path, '"expectedListeners" must be a positive integer');
    const tier = LISTENER_TIERS.find((t) => n <= t.upTo);
    if (!tier) {
      fail(path, `"expectedListeners" above ${LISTENER_TIERS[LISTENER_TIERS.length - 1].upTo} is not supported by one LiveKit node`);
    }
    out.livekitInstanceType = tier.instanceType;
  }
  if (e.advanced !== undefined) {
    const a = e.advanced as Record<string, unknown>;
    if (typeof a !== "object" || a === null || Array.isArray(a)) fail(path, '"advanced" must be an object');
    const known = new Set(knownContextKeys());
    for (const [k, v] of Object.entries(a)) {
      if (!known.has(k)) fail(path, `unknown key "advanced.${k}" (see docs/configuration.md)`);
      out[k] = v;
    }
  }
  return out;
}

/** Event layer for a context getter. eventFile: -c eventFile=<path>|none; default config/event.json if present. */
export function loadEventLayer(eventFileCtx: unknown): { layer: Layer; path: string | null } {
  const raw = eventFileCtx === undefined || eventFileCtx === null ? "" : String(eventFileCtx).trim();
  if (raw === "none") return { layer: {}, path: null };
  const path = raw === "" ? DEFAULT_EVENT_FILE : isAbsolute(raw) ? raw : join(CDK_DIR, raw);
  if (!existsSync(path)) {
    if (raw !== "") throw new Error(`eventFile "${raw}" does not exist`);
    return { layer: {}, path: null };
  }
  return { layer: eventToContext(parseJsonc(readFileSync(path, "utf8"), path), path), path };
}

export interface Resolver {
  /** Resolved value of a context key (undefined if no layer has it). */
  get(key: string): unknown;
  profile: string;
  eventFile: string | null;
  /** Which layer supplied a key. */
  source(key: string): "cli" | "event" | "profile" | "cdk.json" | "unset";
}

/** Build the resolver from a getter of the merged CDK context (cdk.json + -c). */
export function buildResolver(getCtx: (key: string) => unknown): Resolver {
  const fileCtx = cdkJsonContext();
  const explicit = (k: string): boolean => {
    const v = getCtx(k);
    return v !== undefined && String(v) !== String(fileCtx[k]);
  };
  const { layer: event, path } = loadEventLayer(getCtx("eventFile"));
  const presetRaw = explicit("latencyPreset") ? getCtx("latencyPreset") : (event.latencyPreset ?? getCtx("latencyPreset"));
  const profile = presetRaw === undefined || presetRaw === null ? "default" : String(presetRaw).trim().toLowerCase();
  const prof = loadProfile(profile);
  const source = (k: string): "cli" | "event" | "profile" | "cdk.json" | "unset" => {
    if (explicit(k)) return "cli";
    if (Object.prototype.hasOwnProperty.call(event, k)) return "event";
    if (Object.prototype.hasOwnProperty.call(prof, k)) return "profile";
    return getCtx(k) === undefined ? "unset" : "cdk.json";
  };
  const get = (k: string): unknown => {
    switch (source(k)) {
      case "event":
        return event[k];
      case "profile":
        return prof[k];
      default:
        return getCtx(k);
    }
  };
  return { get, profile, eventFile: path, source };
}
