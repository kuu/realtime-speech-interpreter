// One-off calibration of Polly prosody rates for the configured voice (not used at runtime).
// Picks real Japanese chunks from e2e app.log SYNTH lines, synthesizes each at every rate,
// measures the audio duration (raw and silence-trimmed), and optionally transcribes each
// rate's audio with Transcribe streaming ja-JP to get a character error rate (CER) as an
// intelligibility proxy.
// Usage (from repos/app):
//   npx tsx src/tools/polly-calibrate.ts --logs <app.log>... --out <dir>
//     [--rates 100,110,120,130,140,145,150,160] [--n 30] [--no-transcribe]
// Writes <dir>/calibration.json, <dir>/calibration-table.md and <dir>/samples_rate<N>.wav.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
} from "@aws-sdk/client-transcribe-streaming";
import { config } from "../config.js";
import { buildSsml, spokenChars } from "../speed-control.js";

interface Args {
  logs: string[];
  out: string;
  rates: number[];
  n: number;
  transcribe: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { logs: [], out: "calibration", rates: [100, 110, 120, 130, 140, 145, 150, 160], n: 30, transcribe: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--logs") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a.logs.push(argv[++i]);
    } else if (k === "--out") a.out = argv[++i];
    else if (k === "--rates") a.rates = argv[++i].split(",").map(Number);
    else if (k === "--n") a.n = Number(argv[++i]);
    else if (k === "--no-transcribe") a.transcribe = false;
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.logs.length === 0) throw new Error("--logs <app.log>... is required");
  if (!a.rates.includes(100)) a.rates.unshift(100);
  return a;
}

const RE_JA = /SYNTH .*? ja="(.*?)"(?= fillers=| \[corrected|$)/;

// Deduplicated JA texts with 8-60 spoken chars, taken round-robin across files, evenly spread.
function pickTexts(logs: string[], n: number): string[] {
  const perFile = logs.map((p) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = RE_JA.exec(line);
      if (!m) continue;
      const t = m[1].trim();
      const c = spokenChars(t);
      if (c < 8 || c > 60 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  });
  const per = Math.ceil(n / logs.length);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const list of perFile) {
    const step = Math.max(1, Math.floor(list.length / per));
    for (let i = 0, k = 0; i < list.length && k < per; i += step) {
      if (seen.has(list[i])) continue;
      seen.add(list[i]);
      picked.push(list[i]);
      k++;
    }
  }
  return picked.slice(0, n);
}

const polly = new PollyClient({ region: config.region, maxAttempts: 3 });
const SR = config.polly.sampleRateHertz;

async function synth(text: string, rate: number): Promise<Buffer> {
  const ssml = buildSsml(text, rate);
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Text: ssml ?? text,
      TextType: ssml ? "ssml" : "text",
      VoiceId: config.polly.voiceId as any,
      Engine: config.polly.engine as any,
      OutputFormat: "pcm",
      SampleRate: String(SR),
    }),
  );
  const parts: Buffer[] = [];
  for await (const part of res.AudioStream as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

const ms = (bytes: number) => Math.round(bytes / ((SR * 2) / 1000));

function trimmedMs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  let s = 0;
  let e = n - 1;
  while (s < n && Math.abs(pcm.readInt16LE(s * 2)) < 300) s++;
  while (e > s && Math.abs(pcm.readInt16LE(e * 2)) < 300) e--;
  return e > s ? Math.round(((e - s + 1) * 1000) / SR) : 0;
}

function silence(msLen: number): Buffer {
  return Buffer.alloc(Math.round((SR * msLen) / 1000) * 2);
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Normalization for CER: NFKC, lowercase, no whitespace/punctuation/symbols.
function norm(s: string, jaOnly = false): string {
  let t = s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  if (jaOnly) t = t.replace(/[a-z0-9]/g, "");
  return t;
}

function levenshtein(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length];
}

const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

async function transcribe(pcm: Buffer, frameSleepMs: number): Promise<string> {
  const client = new TranscribeStreamingClient({ region: config.region });
  const frame = 3200;
  async function* audio(): AsyncGenerator<AudioStream> {
    for (let o = 0; o < pcm.length; o += frame) {
      yield { AudioEvent: { AudioChunk: pcm.subarray(o, Math.min(pcm.length, o + frame)) } };
      await sleep(frameSleepMs);
    }
  }
  const res = await client.send(
    new StartStreamTranscriptionCommand({
      LanguageCode: "ja-JP",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: SR,
      AudioStream: audio(),
    }),
  );
  const finals: string[] = [];
  for await (const ev of res.TranscriptResultStream ?? []) {
    for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
      if (!r.IsPartial) finals.push(r.Alternatives?.[0]?.Transcript ?? "");
    }
  }
  return finals.join("");
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const texts = pickTexts(args.logs, args.n);
  console.log(`voice=${config.polly.voiceId} engine=${config.polly.engine} sampleRate=${SR} clips=${texts.length} rates=${args.rates.join(",")}`);

  const clips = texts.map((text) => ({ text, chars: spokenChars(text), byRate: {} as Record<number, { rawMs: number; trimmedMs: number }> }));
  const pcmByRate: Record<number, Buffer[]> = {};
  for (const rate of args.rates) {
    pcmByRate[rate] = [];
    for (const c of clips) {
      const pcm = await synth(c.text, rate);
      c.byRate[rate] = { rawMs: ms(pcm.length), trimmedMs: trimmedMs(pcm) };
      pcmByRate[rate].push(pcm);
    }
    // 3 sample sentences per rate, for listening.
    const sample = Buffer.concat(pcmByRate[rate].slice(0, 3).flatMap((p) => [p, silence(600)]));
    writeFileSync(join(args.out, `samples_rate${rate}.wav`), wav(sample));
  }

  const ref = clips.map((c) => c.text).join("");
  const rows: {
    rate: number;
    rawRatio: number;
    trimRatio: number;
    msPerCharRaw: number;
    msPerCharTrim: number;
    totalRawMs: number;
    cer?: number;
    cerJa?: number;
    hyp?: string;
    frameSleepMs?: number;
  }[] = [];
  for (const rate of args.rates) {
    const rawRatio = median(clips.map((c) => c.byRate[rate].rawMs / c.byRate[100].rawMs));
    const trimRatio = median(clips.map((c) => c.byRate[rate].trimmedMs / c.byRate[100].trimmedMs));
    const row: (typeof rows)[number] = {
      rate,
      rawRatio,
      trimRatio,
      msPerCharRaw: median(clips.map((c) => c.byRate[rate].rawMs / c.chars)),
      msPerCharTrim: median(clips.map((c) => c.byRate[rate].trimmedMs / c.chars)),
      totalRawMs: clips.reduce((s, c) => s + c.byRate[rate].rawMs, 0),
    };
    if (args.transcribe) {
      const stream = Buffer.concat([...pcmByRate[rate].flatMap((p) => [p, silence(600)]), silence(2000)]);
      let hyp: string;
      try {
        row.frameSleepMs = 25;
        hyp = await transcribe(stream, 25);
      } catch (err) {
        console.error(`rate ${rate}: transcribe at 4x failed (${String(err)}); retrying at real time`);
        row.frameSleepMs = 100;
        hyp = await transcribe(stream, 100);
      }
      row.hyp = hyp;
      row.cer = levenshtein(norm(ref), norm(hyp)) / Array.from(norm(ref)).length;
      row.cerJa = levenshtein(norm(ref, true), norm(hyp, true)) / Array.from(norm(ref, true)).length;
    }
    rows.push(row);
    console.log(
      `rate=${rate} rawRatio=${rawRatio.toFixed(3)} trimRatio=${trimRatio.toFixed(3)} ` +
        `msPerCharRaw=${row.msPerCharRaw.toFixed(1)} msPerCharTrim=${row.msPerCharTrim.toFixed(1)} ` +
        `totalRawS=${(row.totalRawMs / 1000).toFixed(1)}` +
        (row.cer !== undefined ? ` CER=${(row.cer * 100).toFixed(1)}% CERja=${((row.cerJa ?? 0) * 100).toFixed(1)}%` : ""),
    );
  }

  writeFileSync(
    join(args.out, "calibration.json"),
    JSON.stringify(
      { voice: config.polly.voiceId, engine: config.polly.engine, sampleRate: SR, rates: args.rates, reference: ref, rows, clips },
      null,
      2,
    ),
  );
  const md = [
    `| rate % | median dur ratio (raw) | median dur ratio (trimmed) | ms/char raw | ms/char trimmed | total audio s | CER | CER (kana/kanji only) |`,
    `|---|---|---|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.rate} | ${r.rawRatio.toFixed(3)} | ${r.trimRatio.toFixed(3)} | ${r.msPerCharRaw.toFixed(1)} | ${r.msPerCharTrim.toFixed(1)} | ` +
        `${(r.totalRawMs / 1000).toFixed(1)} | ${r.cer !== undefined ? (r.cer * 100).toFixed(1) + "%" : "-"} | ` +
        `${r.cerJa !== undefined ? (r.cerJa * 100).toFixed(1) + "%" : "-"} |`,
    ),
  ].join("\n");
  writeFileSync(join(args.out, "calibration-table.md"), md + "\n");
  console.log(md);
}

main().catch((err) => {
  console.error("Calibration failed:", err);
  process.exit(1);
});
