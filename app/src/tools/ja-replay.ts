// Replays a JSON file of timed Transcribe results through the Japanese segmenter and prints the distribution report.
//   npx tsx src/tools/ja-replay.ts results.json [simple|full]
// The file is a list of {"t": <wall ms>, "result": <Transcribe result>}. Nothing is sent anywhere.
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { jaSegmenterOptions } from "../segmenter-ja.js";
import { replayJa, type TimedResult } from "../ja-replay.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: ja-replay.ts results.json [simple|full]");
  process.exit(2);
}
const mode = process.argv[3] === "full" ? "full" : "simple";
const stream = JSON.parse(readFileSync(file, "utf8")) as TimedResult[];
console.log(replayJa(stream, { ...jaSegmenterOptions(config), mode }).report);
