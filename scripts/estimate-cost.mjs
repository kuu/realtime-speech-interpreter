#!/usr/bin/env node
// Estimate the AWS cost of one session and of leaving the stack deployed. No dependencies.
//
//   node scripts/estimate-cost.mjs [--hours 4] [--listeners 100] [--engine translate|llm]
//                                  [--chunks-per-hour 1130] [--idle-days 0] [--markdown] [--json]
//
// Sizing comes from cdk/cdk.json (taskCpu, taskMemoryMiB, livekitInstanceType, logRetentionDays,
// translateEngine) and, when present, the selected profile and cdk/config/event.json.
// Prices come from scripts/cost-prices.json (AWS Price List API, dated). See docs/cost.md.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ------------------------------------------------------------------ measured volumes (docs/cost.md, "Where the numbers come from")
// One cloud run of 2,389 s of recorded English speech, fast chunking profile with the LLM engine.
const MEASURED = {
  chunksPerHour: 1130, // 750 synthesized chunks in 2,389 s
  pollyCharsPerChunk: 22.0, // Japanese characters sent to Polly per chunk
  translateCharsPerChunk: 28.3, // English characters sent to Translate per chunk (31,900 per hour at 1,130 chunks per hour)
  llmCallShare: 0.99, // 745 of 750 chunks went to the model (the rest fell back to Translate)
  llmIn: 126, // uncached input tokens per call
  llmCacheRead: 5470,
  llmOut: 16.5,
  llmCacheWritePerSession: 5300, // glossary + prompt written to the cache once per start
  appLogMbPerHour: 0.93, // app log volume of the same run
};
// Not measured in this repository: assumptions, labelled as such in the output.
const ASSUMED = {
  opusKbps: 32, // audio bitrate of the published track (LiveKit default for this publisher is not verified)
  rtpOverheadKbps: 20, // 50 packets/s x about 50 bytes of RTP/SRTP/UDP/IP headers
  otherLogsShare: 0.18, // LiveKit + token function log volume relative to the app log (from stored bytes)
  pageBytesPerListener: 12_000, // index.html + subscriber.js + token response, before HTTP overhead
  httpsRequestsPerListener: 3, // page, script, /token
  lambdaMsPerInvoke: 100,
  secretsApiCallsPerSession: 10,
  nlbLcuPerHour: 1, // upper bound: one SRT flow is far below one LCU
  ebsGb: 20,
  ecrImageGb: 1,
};
const LISTENER_TIERS = [
  { upTo: 300, type: "c6i.large" },
  { upTo: 1000, type: "c6i.xlarge" },
  { upTo: 3000, type: "c6i.2xlarge" },
];
const HOURS_PER_MONTH = 730;

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (["markdown", "json", "help"].includes(k)) o[k] = true;
    else {
      const v = argv[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      o[k] = v;
    }
  }
  return o;
}
function fail(msg) {
  console.error(`estimate-cost: ${msg}`);
  process.exit(2);
}
function num(o, k, dflt) {
  if (o[k] === undefined) return dflt;
  const n = Number(o[k]);
  if (!Number.isFinite(n) || n < 0) fail(`--${k} must be a number >= 0`);
  return n;
}
const HELP = `Usage: node scripts/estimate-cost.mjs [options]
  --hours N              session length in hours (default 4)
  --listeners N          concurrent listeners (default expectedListeners from event.json, else 100)
  --engine translate|llm translation engine (default from event.json / profile / cdk.json)
  --chunks-per-hour N    synthesized chunks per hour of speech (default ${MEASURED.chunksPerHour}, measured, fast profile)
  --idle-days N          also print the cost of leaving the stack deployed for N days
  --polly-chars-per-hour N, --translate-chars-per-hour N   override the volumes derived from chunks
  --llm-in N --llm-cache-read N --llm-out N                 tokens per model call
  --llm-call-share F     share of chunks sent to the model (default ${MEASURED.llmCallShare})
  --bedrock-price regional|global   jp. in-country profile (default) or global list price
  --opus-kbps N          audio bitrate per listener (default ${ASSUMED.opusKbps}, assumed)
  --instance-type T      LiveKit instance type (default from the listener tier or event.json)
  --markdown             print Markdown tables;  --json  print the numbers as JSON`;

// ------------------------------------------------------------------ config
function readJsonLoose(path) {
  const t = readFileSync(path, "utf8");
  // event.json may carry // and /* */ comments (see docs/configuration.md)
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1];
    if (inStr) { out += c; if (c === "\\") out += t[++i]; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out);
}
function loadSizing() {
  const cdkJson = readJsonLoose(join(root, "cdk", "cdk.json")).context ?? {};
  const ctx = { ...cdkJson };
  let ev = {};
  const evPath = join(root, "cdk", "config", "event.json");
  if (existsSync(evPath)) {
    ev = readJsonLoose(evPath);
    if (ev.profile) {
      const pp = join(root, "cdk", "config", "profiles", `${ev.profile}.json`);
      if (existsSync(pp)) Object.assign(ctx, readJsonLoose(pp).context ?? {});
    }
    if (ev.translateEngine) ctx.translateEngine = ev.translateEngine;
    Object.assign(ctx, ev.advanced ?? {});
  }
  return { ctx, ev, usedEvent: existsSync(evPath) };
}

// ------------------------------------------------------------------ model
export function estimate(opts = {}, sizing = loadSizing(), prices = readJsonLoose(join(here, "cost-prices.json"))) {
  const P = prices.prices;
  const { ctx, ev } = sizing;
  const hours = num(opts, "hours", 4);
  const listeners = num(opts, "listeners", ev.expectedListeners ?? 100);
  const engine = opts.engine ?? ctx.translateEngine ?? "translate";
  if (!["translate", "llm"].includes(engine)) fail("--engine must be translate or llm");
  const chunks = num(opts, "chunks-per-hour", MEASURED.chunksPerHour);
  const scale = chunks / MEASURED.chunksPerHour;
  const pollyChars = num(opts, "polly-chars-per-hour", chunks * MEASURED.pollyCharsPerChunk);
  const translateCharsAll = num(opts, "translate-chars-per-hour", chunks * MEASURED.translateCharsPerChunk);
  const llmShare = num(opts, "llm-call-share", MEASURED.llmCallShare);
  const llmIn = num(opts, "llm-in", MEASURED.llmIn);
  const llmCr = num(opts, "llm-cache-read", MEASURED.llmCacheRead);
  const llmOut = num(opts, "llm-out", MEASURED.llmOut);
  const bedrockPrice = opts["bedrock-price"] ?? "regional";
  if (!["regional", "global"].includes(bedrockPrice)) fail("--bedrock-price must be regional or global");
  const opusKbps = num(opts, "opus-kbps", ASSUMED.opusKbps);
  const instanceType = opts["instance-type"] ?? ev.advanced?.livekitInstanceType ??
    (LISTENER_TIERS.find((t) => listeners <= t.upTo)?.type ?? "c6i.2xlarge");
  if (P.ec2Hour[instanceType] === undefined) fail(`no price for instance type ${instanceType} (c6i.large, c6i.xlarge, c6i.2xlarge)`);
  const taskCpu = Number(ctx.taskCpu), taskMem = Number(ctx.taskMemoryMiB);
  const vcpu = taskCpu / 1024, gb = taskMem / 1024;

  // hourly rates of the always-on parts
  const fargate = vcpu * P.fargateArmVcpuHour.usd + gb * P.fargateArmGbHour.usd;
  const nlb = P.nlbHour.usd + ASSUMED.nlbLcuPerHour * P.nlbLcuHour.usd;
  const ipNlb = 2 * P.publicIpv4Hour.usd; // SrtEip1, SrtEip2 (one per AZ)
  const ipLk = P.publicIpv4Hour.usd;
  const ipTask = P.publicIpv4Hour.usd; // Fargate task public IP (no NAT)
  const ec2 = P.ec2Hour[instanceType];
  const ebs = (ASSUMED.ebsGb * P.ebsGp3GbMonth.usd) / HOURS_PER_MONTH;
  const secrets = (2 * P.secretMonth.usd) / HOURS_PER_MONTH;
  const idleOther = (ASSUMED.ecrImageGb * P.ecrGbMonth.usd) / HOURS_PER_MONTH; // image stored in the CDK bootstrap ECR repo

  // usage-based
  const bedrockKey = (s) => P[`bedrockHaiku${bedrockPrice === "regional" ? "Regional" : "Global"}${s}`].usd;
  const llmCalls = engine === "llm" ? chunks * llmShare : 0;
  const translateChars = engine === "llm" ? translateCharsAll * (1 - llmShare) : translateCharsAll;
  const sessionCacheWrite = engine === "llm" ? MEASURED.llmCacheWritePerSession : 0;
  const kbpsTotal = opusKbps + ASSUMED.rtpOverheadKbps;
  const gbPerListenerHour = (kbpsTotal * 1000 * 3600) / 8 / 1e9;
  const transferGbPerHour = listeners * gbPerListenerHour;
  const logGbPerHour = (MEASURED.appLogMbPerHour * scale * (1 + ASSUMED.otherLogsShare)) / 1000;

  const perHour = {
    "Fargate task (vCPU + memory)": fargate,
    "Network Load Balancer (hour + LCU)": nlb,
    "Public IPv4 addresses (2 NLB, 1 LiveKit, 1 Fargate task)": ipNlb + ipLk + ipTask,
    [`EC2 ${instanceType} (LiveKit)`]: ec2,
    [`EBS gp3 ${ASSUMED.ebsGb} GB (LiveKit)`]: ebs,
    "Secrets Manager (2 secrets, monthly fee prorated)": secrets,
    "Transcribe streaming (3,600 s of audio)": 3600 * P.transcribeStreamingSecond.usd,
    "Translate": translateChars * P.translateChar.usd,
    "Polly neural": pollyChars * P.pollyNeuralChar.usd,
    "Bedrock Haiku 4.5 (input + cache read + output)":
      (llmCalls * (llmIn * bedrockKey("InputMTok") + llmCr * bedrockKey("CacheReadMTok") + llmOut * bedrockKey("OutputMTok"))) / 1e6,
    "Bedrock cache write (once per start, spread over the session)":
      (sessionCacheWrite * P.bedrockHaikuRegionalCacheWriteMTok.usd) / 1e6 / hours,
    "CloudWatch Logs ingestion": logGbPerHour * P.logsIngestGb.usd,
    "Data transfer out to listeners (LiveKit audio)": transferGbPerHour * P.dataTransferOutGb.usd,
  };
  // per-listener-join costs (once per session, spread over the hours)
  const joinCost =
    listeners *
    ((ASSUMED.httpsRequestsPerListener * P.cloudFrontHttpsRequest10k.usd) / 1e4 +
      (ASSUMED.pageBytesPerListener / 1e9) * P.cloudFrontTransferGb.usd +
      P.lambdaRequest.usd +
      (ASSUMED.lambdaMsPerInvoke / 1000) * 0.125 * P.lambdaArmGbSecond.usd +
      P.s3GetPer10k.usd / 1e4);
  perHour["CloudFront + S3 + Lambda (listener page and token, once per listener)"] = joinCost / hours;
  perHour["Secrets Manager API calls (per session)"] = (ASSUMED.secretsApiCallsPerSession * P.secretsApiPer10k.usd) / 1e4 / hours;

  const sessionHour = Object.values(perHour).reduce((a, b) => a + b, 0);
  const idleFargateOn = fargate + ipNlb + ipLk + ipTask + nlb + ec2 + ebs + secrets + idleOther;
  // nlb counted at the LCU upper bound; idle traffic is near zero, so drop the LCU part
  const idleNlb = P.nlbHour.usd;
  const idle = {
    "Left deployed as is (ECS desired count 1)": idleFargateOn - nlb + idleNlb,
    "ECS desired count 0": idleFargateOn - nlb + idleNlb - fargate - ipTask,
    "ECS desired count 0 and LiveKit instance stopped": idleFargateOn - nlb + idleNlb - fargate - ipTask - ec2,
    "After cdk destroy (CDK bootstrap image storage only)": idleOther,
  };
  return {
    meta: {
      pricesAsOf: prices.asOf, region: prices.region, basis: prices.basis, hours, listeners, engine, chunksPerHour: chunks,
      instanceType, taskCpu, taskMemoryMiB: taskMem, pollyCharsPerHour: pollyChars, translateCharsPerHour: translateChars,
      llmCallsPerHour: llmCalls, llmTokensPerCall: { in: llmIn, cacheRead: llmCr, out: llmOut }, bedrockPrice,
      opusKbps, rtpOverheadKbps: ASSUMED.rtpOverheadKbps, transferGbPerHour, usedEventJson: sizing.usedEvent,
    },
    perHour,
    sessionHour,
    sessionTotal: sessionHour * hours,
    idle,
    resources: resourceList(P, { vcpu, gb, instanceType, taskCpu, taskMem }),
  };
}

// ------------------------------------------------------------------ list of billed resources
function resourceList(P, s) {
  const r = (service, resource, dimension, price, when, kind, note = "") => ({ service, resource, dimension, price, when, kind, note });
  return [
    r("ECS Fargate", "App task (ARM64)", `vCPU-hours (${s.vcpu} vCPU) + GB-hours (${s.gb} GB)`, `$${P.fargateArmVcpuHour.usd} per vCPU-h, $${P.fargateArmGbHour.usd} per GB-h`, "while the task runs (desired count 1)", "time", "20 GiB task storage included."),
    r("Elastic Load Balancing", "Network Load Balancer for SRT", "NLB-hours + LCU-hours", `$${P.nlbHour.usd} per h, $${P.nlbLcuHour.usd} per LCU-h`, "while it exists", "time", "One SRT flow uses far less than 1 LCU."),
    r("VPC (public IPv4)", "2 Elastic IPs on the NLB (one per AZ)", "address-hours", `$${P.publicIpv4Hour.usd} per h each`, "while allocated", "time"),
    r("VPC (public IPv4)", "1 Elastic IP on the LiveKit instance", "address-hours", `$${P.publicIpv4Hour.usd} per h`, "while allocated, also while the instance is stopped", "time"),
    r("VPC (public IPv4)", "Public IP of the Fargate task (no NAT gateway)", "address-hours", `$${P.publicIpv4Hour.usd} per h`, "while a task runs", "time"),
    r("EC2", `LiveKit server, ${s.instanceType}`, "instance-hours", `$${P.ec2Hour[s.instanceType]} per h`, "while running", "time"),
    r("EBS", `Root volume ${ASSUMED.ebsGb} GB gp3`, "GB-months", `$${P.ebsGp3GbMonth.usd} per GB-month`, "while the volume exists, also while the instance is stopped", "time"),
    r("Secrets Manager", "2 secrets (LiveKit API key, SRT passphrase)", "secret-months + API calls", `$${P.secretMonth.usd} per secret-month, $${P.secretsApiPer10k.usd} per 10,000 calls`, "while they exist", "time"),
    r("CloudFront", "Listener page and /token behavior", "HTTPS requests + data transfer out", `$${P.cloudFrontHttpsRequest10k.usd} per 10,000, $${P.cloudFrontTransferGb.usd} per GB`, "per listener join", "usage", "No cost without traffic. Price class 200."),
    r("S3", "Site bucket", "GB-months + requests", `$${P.s3StorageGbMonth.usd} per GB-month`, "a few KB stored", "usage", "Negligible."),
    r("Lambda", "Token function (ARM64, 128 MB)", "requests + GB-seconds", `$${P.lambdaRequest.usd.toFixed(7)} per request`, "per listener join", "usage", "Negligible."),
    r("CloudWatch Logs", "3 log groups (app, livekit, token)", "GB ingested + GB-months stored", `$${P.logsIngestGb.usd} per GB, $${P.logsStorageGbMonth.usd} per GB-month`, "per log volume, retention from logRetentionDays", "usage"),
    r("Data transfer", "LiveKit audio to listeners (EC2 to internet)", "GB out", `$${P.dataTransferOutGb.usd} per GB`, "listeners x bitrate x time", "usage", "SRT/ingest inbound traffic is free."),
    r("Transcribe", "Streaming transcription with language identification", "seconds of audio", `$${P.transcribeStreamingSecond.usd} per s (about $0.01 per min)`, "while audio is sent", "usage", "Language identification and custom vocabulary have no separate charge (AWS Transcribe pricing page)."),
    r("Translate", "TranslateText (translate engine, and fallback of the llm engine)", "characters", `$${P.translateChar.usd} per character`, "per translated chunk", "usage", "Terminology has no separate charge."),
    r("Polly", "SynthesizeSpeech, neural voice", "characters", `$${P.pollyNeuralChar.usd} per character`, "per spoken chunk", "usage", "Lexicons are not used. Readings are SSML sub aliases."),
    r("Bedrock", "Claude Haiku 4.5 via the jp. inference profile (llm engine only)", "input, output, cache-read and cache-write tokens", `$${P.bedrockHaikuRegionalInputMTok.usd} in, $${P.bedrockHaikuRegionalOutputMTok.usd} out, $${P.bedrockHaikuRegionalCacheReadMTok.usd} cache read, $${P.bedrockHaikuRegionalCacheWriteMTok.usd} cache write, per million tokens`, "per chunk", "usage"),
    r("ECR (CDK bootstrap)", "App container image", "GB-months", `$${P.ecrGbMonth.usd} per GB-month`, "stays after cdk destroy", "time"),
    r("Free of charge", "Transcribe custom vocabulary, Translate terminology, ECS cluster, VPC, subnets, security groups, IAM, CloudFormation", "none", "$0", "", "free"),
  ];
}

// ------------------------------------------------------------------ output
const usd = (n, d) => `$${n.toFixed(d ?? (n >= 1 ? 2 : n >= 0.01 ? 3 : 4))}`;
function render(res, o) {
  const m = res.meta, md = !!o.markdown;
  const out = [];
  const table = (head, rows) => {
    if (md) {
      out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`));
    } else {
      const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
      const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
      out.push(line(head), line(w.map((x) => "-".repeat(x))), ...rows.map(line));
    }
    out.push("");
  };
  const h = (t) => out.push(md ? `#### ${t}` : `== ${t} ==`, "");
  out.push(`Prices as of ${m.pricesAsOf}, region ${m.region}, USD, list price, tax excluded, free tiers and discounts not applied.`, "");
  out.push(`Session: ${m.hours} h, ${m.listeners} listeners, engine ${m.engine}, ${m.chunksPerHour} chunks/h, LiveKit ${m.instanceType}, Fargate ${m.taskCpu / 1024} vCPU / ${m.taskMemoryMiB / 1024} GB.`, "");
  h("Billed resources");
  table(["Service", "Resource", "Pricing dimension", "Price", "Billed"], res.resources.map((r) => [r.service, r.resource, r.dimension, r.price, r.when || "-"]));
  h(`Cost per hour of a running session (${m.hours} h, ${m.listeners} listeners, ${m.engine})`);
  const rows = Object.entries(res.perHour).filter(([, v]) => v > 0).map(([k, v]) => [k, usd(v), `${((v / res.sessionHour) * 100).toFixed(1)}%`]);
  rows.push(["Total per hour", usd(res.sessionHour), "100%"], [`Total for ${m.hours} h`, usd(res.sessionTotal), ""]);
  table(["Item", "USD per hour", "Share"], rows);
  h("Cost with no session");
  table(["State", "USD per hour", "USD per day", "USD per 30 days"], Object.entries(res.idle).map(([k, v]) => [k, usd(v), usd(v * 24), usd(v * 24 * 30)]));
  if (o["idle-days"]) {
    const d = Number(o["idle-days"]);
    out.push(`Left deployed for ${d} day(s) as is: ${usd(res.idle["Left deployed as is (ECS desired count 1)"] * 24 * d)}.`, "");
  }
  out.push(
    `Measured: chunks, Polly characters, Translate characters and LLM tokens per chunk (one cloud run, see docs/cost.md), the log volume. ` +
      `Estimated: listener audio bitrate (${m.opusKbps} kbps + ${m.rtpOverheadKbps} kbps headers = ${m.transferGbPerHour.toFixed(3)} GB/h for ${m.listeners} listeners), ` +
      `NLB LCU (upper bound 1), per-listener page cost, EBS size, ECR size. ${m.usedEventJson ? "Sizing read from cdk/cdk.json and cdk/config/event.json." : "Sizing read from cdk/cdk.json."}`,
  );
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); process.exit(0); }
  const res = estimate(o);
  console.log(o.json ? JSON.stringify(res, null, 2) : render(res, o));
}
