#!/usr/bin/env node
// Language scan: streams a 16 kHz mono s16le PCM file to Amazon Transcribe streaming with
// multi-language identification (en-US + ja-JP) and prints one JSON line per FINAL result:
//   {"start":12.3,"end":15.9,"lang":"ja-JP","scores":{...},"text":"..."}   (times in seconds of the file)
// Used by `e2e.sh langscan` to locate Japanese speech in the test recordings.
// Uses the AWS SDK already installed in app (no new dependencies).
//
// Usage: node langscan.cjs <app-dir> <pcm-file>
// Audio is paced at real time (Transcribe streaming consumes it at real time anyway).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [appDir, pcmFile] = process.argv.slice(2);
if (!appDir || !pcmFile) {
  console.error("usage: langscan.cjs <app-dir> <pcm-file>");
  process.exit(2);
}
const appRequire = createRequire(path.join(path.resolve(appDir), "package.json"));
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} = appRequire("@aws-sdk/client-transcribe-streaming");

const SR = 16000;
const FRAME = 3200; // 100 ms
const region = process.env.AWS_REGION || "ap-northeast-1";

async function* audio() {
  const fd = fs.openSync(pcmFile, "r");
  const buf = Buffer.alloc(FRAME);
  const t0 = Date.now();
  let sent = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, FRAME, null);
      if (n <= 0) break;
      yield { AudioEvent: { AudioChunk: Buffer.from(buf.subarray(0, n)) } };
      sent += n;
      const due = t0 + (sent / (SR * 2)) * 1000;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const client = new TranscribeStreamingClient({ region });
  const res = await client.send(
    new StartStreamTranscriptionCommand({
      MediaEncoding: "pcm",
      MediaSampleRateHertz: SR,
      IdentifyMultipleLanguages: true,
      LanguageOptions: "en-US,ja-JP",
      PreferredLanguage: "en-US",
      AudioStream: audio(),
    }),
  );
  for await (const ev of res.TranscriptResultStream) {
    const results = ev.TranscriptEvent?.Transcript?.Results ?? [];
    for (const r of results) {
      if (r.IsPartial) continue;
      const scores = {};
      for (const li of r.LanguageIdentification ?? []) {
        if (li.LanguageCode && typeof li.Score === "number") scores[li.LanguageCode] = Number(li.Score.toFixed(3));
      }
      process.stdout.write(
        JSON.stringify({
          start: Number((r.StartTime ?? 0).toFixed(2)),
          end: Number((r.EndTime ?? 0).toFixed(2)),
          lang: r.LanguageCode ?? "",
          scores,
          text: r.Alternatives?.[0]?.Transcript ?? "",
        }) + "\n",
      );
    }
  }
}

main().catch((err) => {
  console.error(`langscan error: ${err && err.name}: ${err && err.message}`);
  process.exit(1);
});
