// Optional: ask a Bedrock model for Japanese terms and katakana readings for proposed terms.
// Off unless `suggest --suggest-with-bedrock` is given. Uses the AWS CLI (`aws bedrock-runtime converse`), so the
// project needs no SDK dependency. Every suggestion is marked UNVERIFIED; the English term is never changed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READING_OK = /^[\p{Script=Katakana}\p{Script=Hiragana}ー・0-9 ]+$/u;

/** Model id: --model, else LLM_MODEL_ID, else llmModelId from cdk/cdk.json. */
export function defaultModelId({ model, env = process.env, root }) {
  if (model) return model;
  if (env.LLM_MODEL_ID) return env.LLM_MODEL_ID;
  const f = join(root, "cdk", "cdk.json");
  if (existsSync(f)) {
    const id = JSON.parse(readFileSync(f, "utf8"))?.context?.llmModelId;
    if (id) return id;
  }
  throw new Error("no model id: pass --model or set LLM_MODEL_ID");
}
export function defaultRegion({ region, env = process.env }) {
  return region || env.AWS_REGION || "ap-northeast-1";
}

/** USD per million tokens for Haiku models, from scripts/cost-prices.json; null for other models. */
export function pricesFor(modelId, root) {
  if (!/haiku/i.test(modelId)) return null;
  const f = join(root, "scripts", "cost-prices.json");
  if (!existsSync(f)) return null;
  const p = JSON.parse(readFileSync(f, "utf8")).prices;
  const inUsd = p?.bedrockHaikuRegionalInputMTok?.usd;
  const outUsd = p?.bedrockHaikuRegionalOutputMTok?.usd;
  return typeof inUsd === "number" && typeof outUsd === "number" ? { inUsd, outUsd } : null;
}
const usd = (tokensIn, tokensOut, pr) => (pr ? (tokensIn * pr.inUsd + tokensOut * pr.outUsd) / 1e6 : null);

const SYSTEM =
  "You help prepare a dictionary for a live English to Japanese interpreter. For each English term you get, return its Japanese form and how a Japanese speaker says it aloud. " +
  "Answer with ONLY a JSON array of objects {\"en\": string, \"ja\": string, \"reading\": string}, one per input term, in the same order, with \"en\" copied exactly. " +
  "Rules: product names, company names, people's names, acronyms, protocol and code names keep their English spelling in \"ja\" (ja equals en). " +
  "Translate only ordinary technical words. \"reading\" is the spoken form in katakana (katakana, the long-vowel mark, spaces and digits only; spell digits as katakana or digits). No other text.";

export function buildRequest(terms) {
  const user = `Terms:\n${JSON.stringify(terms.map((t) => t.term))}`;
  return { system: SYSTEM, user };
}

/** Rough token estimate (about 3 characters per token) and the cost range. */
export function estimateCost({ system, user }, nTerms, modelId, root) {
  const inputTokens = Math.ceil((system.length + user.length) / 3);
  const outputTokens = Math.max(200, nTerms * 45);
  const pr = pricesFor(modelId, root);
  return { inputTokens, outputTokens, usd: usd(inputTokens, outputTokens, pr), priced: !!pr };
}

/** Enforce the safeguards on a model answer. Returns Map(term -> { ja?, reading? }) of accepted suggestions. */
export function acceptSuggestions(answer, terms) {
  const byEn = new Map(terms.map((t) => [t.term, t]));
  const out = new Map();
  if (!Array.isArray(answer)) return out;
  for (const a of answer) {
    if (!a || typeof a.en !== "string" || !byEn.has(a.en)) continue; // echoed en must match an input exactly
    const sug = {};
    const productLike = /[A-Z0-9]/.test(a.en);
    if (productLike) sug.ja = a.en; // product names, acronyms and names keep their English spelling
    else if (typeof a.ja === "string") {
      const ja = a.ja.trim().replace(/ {2,}/g, " ");
      if (ja && !/[,"\t\r\n]/.test(ja) && Buffer.byteLength(ja) <= 200) sug.ja = ja;
    }
    if (typeof a.reading === "string") {
      const r = a.reading.trim().replace(/ {2,}/g, " ");
      if (READING_OK.test(r.replace(/\bAWS\b/g, ""))) sug.reading = r;
    }
    out.set(a.en, sug);
  }
  return out;
}

/**
 * Call the model once for `terms` (an array of { term }). Returns { suggestions, usage }.
 * `exec` can be replaced in tests; by default it runs the aws CLI found on PATH.
 */
export function askBedrock(terms, { modelId, region, exec = spawnSync }) {
  const { system, user } = buildRequest(terms);
  const maxTokens = Math.max(1024, terms.length * 80);
  const args = [
    "bedrock-runtime", "converse",
    "--model-id", modelId,
    "--region", region,
    "--system", JSON.stringify([{ text: system }]),
    "--messages", JSON.stringify([{ role: "user", content: [{ text: user }] }]),
    "--inference-config", JSON.stringify({ maxTokens, temperature: 0 }),
    "--output", "json",
  ];
  let r = exec("aws", args, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.error) throw new Error(`could not run the aws CLI: ${r.error.message}`);
  let text = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  if (r.status !== 0 && /Invalid choice|invalid choice|argument operation/.test(r.stderr || "")) {
    // Older AWS CLI without `converse`: use invoke-model with the Anthropic Messages format (Claude models only).
    const dir = mkdtempSync(join(tmpdir(), "bedrock-"));
    try {
      const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: [{ type: "text", text: user }] }] };
      writeFileSync(join(dir, "req.json"), JSON.stringify(body));
      r = exec("aws", ["bedrock-runtime", "invoke-model", "--model-id", modelId, "--region", region, "--body", `fileb://${join(dir, "req.json")}`,
        "--content-type", "application/json", "--accept", "application/json", join(dir, "resp.json")], { encoding: "utf8", maxBuffer: 1 << 24 });
      if (r.error) throw new Error(`could not run the aws CLI: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`aws bedrock-runtime invoke-model failed: ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
      const res = JSON.parse(readFileSync(join(dir, "resp.json"), "utf8"));
      text = (res.content ?? []).map((c) => c.text ?? "").join("");
      usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    if (r.status !== 0) throw new Error(`aws bedrock-runtime converse failed: ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
    const res = JSON.parse(r.stdout);
    text = res?.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    usage = { inputTokens: res?.usage?.inputTokens ?? 0, outputTokens: res?.usage?.outputTokens ?? 0 };
  }
  const json = /\[[\s\S]*\]/.exec(text);
  let answer = [];
  try {
    answer = json ? JSON.parse(json[0]) : [];
  } catch {
    throw new Error("the model did not return valid JSON; nothing was changed");
  }
  return { suggestions: acceptSuggestions(answer, terms), usage };
}

export const formatUsd = (v) => (v === null ? "price unknown for this model" : v < 0.01 ? `about $${v.toFixed(4)}` : `about $${v.toFixed(3)}`);
export { usd as costUsd };
