#!/usr/bin/env node
// Operator command for browser microphone input: generates the event code, stores it, sets the event end time
// (UTC) and prints URL and code once. Running it again rotates the code.
//
//   node cdk/scripts/publisher-code.mjs --ends-at 2026-11-06T09:00:00Z [--disconnect] [--dry-run]
//
// Env: AWS_REGION (default ap-northeast-1), STACK_NAME (default SimulTranslation). Needs the AWS CLI and the
// operator's own AWS identity. The code is never an argument, never written to a file, never put in argv or the
// environment of a child process; it goes to `aws` on stdin and to this terminal's stdout, once.
import { execFileSync } from "node:child_process";
import { createHmac, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 12;
const ENDS_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const USAGE = "usage: node cdk/scripts/publisher-code.mjs --ends-at YYYY-MM-DDTHH:MM:SSZ [--disconnect] [--dry-run]\n" +
  "  --ends-at     event end time in UTC, for example 2026-11-06T09:00:00Z (required, must be in the future)\n" +
  "  --disconnect  also remove the current browser publisher from the ingest room\n" +
  "  --dry-run     validate and show what would happen; no AWS call, nothing stored";

export function parseArgs(argv) {
  const o = { endsAt: undefined, disconnect: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ends-at") o.endsAt = argv[++i];
    else if (a.startsWith("--ends-at=")) o.endsAt = a.slice("--ends-at=".length);
    else if (a === "--disconnect") o.disconnect = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new UsageError(`unknown option: ${a}`);
  }
  return o;
}
class UsageError extends Error {}

export function validateEndsAt(v, nowMs = Date.now()) {
  const form = "Use UTC with a Z suffix, for example 2026-11-06T09:00:00Z.";
  if (typeof v !== "string" || v === "") throw new UsageError(`--ends-at is required. ${form}`);
  if (!ENDS_AT_RE.test(v)) throw new UsageError(`--ends-at "${v}" is not accepted. ${form}`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) + "Z" !== v) throw new UsageError(`--ends-at "${v}" is not a real calendar time. ${form}`);
  if (ms <= nowMs) throw new UsageError(`--ends-at "${v}" is not in the future.`);
  return v;
}

export function generateCode() {
  let c = "";
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}
export const formatCode = (c) => c.replace(/(.{4})(?=.)/g, "$1-");

function aws(args, { input } = {}) {
  // execFile with an argument array: no shell, so no injection and no quoting.
  return execFileSync("aws", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function httpBase(wsUrl) {
  const u = new URL(wsUrl);
  if (u.protocol === "wss:") return `https://${u.host}`;
  if (u.protocol === "ws:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return `http://${u.host}`;
  throw new Error("LiveKitUrl must be wss:// (ws:// only for a loopback test server)");
}

function adminToken(apiKey, apiSecret, room) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const si = `${b({ alg: "HS256", typ: "JWT" })}.${b({ iss: apiKey, sub: "operator", nbf: now, exp: now + 60, video: { roomAdmin: true, room } })}`;
  return `${si}.${createHmac("sha256", apiSecret).update(si).digest("base64url")}`;
}

async function disconnect(outputs) {
  const sec = JSON.parse(aws(["secretsmanager", "get-secret-value", "--secret-id", outputs.LiveKitApiSecretArn, "--query", "SecretString", "--output", "text", "--region", region]).trim());
  const room = outputs.PublisherIngestRoom;
  const res = await fetch(`${httpBase(outputs.LiveKitUrl)}/twirp/livekit.RoomService/RemoveParticipant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken(sec.apiKey, sec.apiSecret, room)}` },
    body: JSON.stringify({ room, identity: "browser-publisher" }),
  });
  if (res.ok) return "removed";
  const text = await res.text().catch(() => "");
  if (res.status === 404 || /not_found|not found/i.test(text)) return "none connected";
  throw new Error(`RemoveParticipant answered HTTP ${res.status}`);
}

const region = process.env.AWS_REGION || "ap-northeast-1";
const stack = process.env.STACK_NAME || "SimulTranslation";

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }
  const endsAt = validateEndsAt(o.endsAt);

  if (o.dryRun) {
    console.log("dry run: no AWS call, nothing generated or stored");
    console.log(`  stack ${stack} in ${region}`);
    console.log(`  would write a new ${CODE_LEN}-character code to the code secret`);
    console.log(`  would set the event end time to ${endsAt} (UTC)`);
    if (o.disconnect) console.log("  would remove the current browser publisher from the ingest room");
    console.log("  publisher URL: https://<site>/publish");
    console.log("  event code:    <code not generated in dry run>");
    return 0;
  }

  let outputs;
  try {
    const list = JSON.parse(aws(["cloudformation", "describe-stacks", "--stack-name", stack, "--region", region, "--query", "Stacks[0].Outputs", "--output", "json"]));
    outputs = Object.fromEntries((list ?? []).map((x) => [x.OutputKey, x.OutputValue]));
  } catch {
    console.error(`cannot read the stack outputs of ${stack} in ${region}. Check AWS_REGION, STACK_NAME and your credentials.`);
    return 1;
  }
  for (const k of ["PublisherCodeSecretArn", "PublisherNotAfterParameter", "PublisherUrl"]) {
    if (!outputs[k]) { console.error("the stack has no browser input: deploy the stack with -c inputSource=browser first"); return 1; }
  }

  const code = generateCode();
  const scrub = (s) => String(s).split(code).join("***");
  try {
    aws(["secretsmanager", "put-secret-value", "--secret-id", outputs.PublisherCodeSecretArn, "--secret-string", "file:///dev/stdin", "--region", region, "--output", "json"], { input: JSON.stringify({ code }) });
    aws(["ssm", "put-parameter", "--name", outputs.PublisherNotAfterParameter, "--type", "String", "--overwrite", "--value", endsAt, "--region", region]);
  } catch (e) {
    console.error(`could not store the code or the end time: ${scrub(e.stderr || e.message).trim().split("\n")[0]}`);
    return 1;
  }

  let status = 0;
  let disc = "";
  if (o.disconnect) {
    try { disc = await disconnect(outputs); } catch (e) {
      console.error(`warning: could not remove the current publisher: ${scrub(e.message)}`);
      status = 1;
    }
  }
  console.log(`publisher URL: ${outputs.PublisherUrl}`);
  console.log(`event code:    ${formatCode(code)}`);
  console.log(`ends at:       ${endsAt} (UTC)`);
  if (disc) console.log(`publisher:     ${disc}`);
  console.log("Send the URL and the code to speakers in Slack. Paste the code on the laptop screen only, not on the projected screen.");
  return status;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((c) => { process.exitCode = c; }, (e) => {
    if (e instanceof UsageError) { console.error(`${e.message}\n${USAGE}`); process.exitCode = 2; }
    else { console.error(`error: ${e.message}`); process.exitCode = 1; }
  });
}
