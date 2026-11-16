import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../lib/csv.mjs";
import { acceptSuggestions, estimateCost, buildRequest } from "../lib/bedrock.mjs";
import { COLUMNS } from "../lib/terms.mjs";
import { REPO, build, cleanup, makeDict, stubBin, tmp } from "./helpers.mjs";

const MODEL = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";
const TEXT = "We ship StreamDeck today. The quokkaform encoder works.\n";
const ANSWER = [
  { en: "StreamDeck", ja: "ストリームデック", reading: "ストリームデッキ" },
  { en: "quokkaform", ja: "クオッカフォーム", reading: "Quokka" },
  { en: "NotAnInput", ja: "x", reading: "エックス" },
];
function awsStub(logDir) {
  const body = JSON.stringify({ output: { message: { content: [{ text: "Here you go:\n" + JSON.stringify(ANSWER) }] } }, usage: { inputTokens: 400, outputTokens: 120 } });
  const resp = join(logDir, "resp.json");
  writeFileSync(resp, body);
  return stubBin("aws", `echo "$@" >> "${join(logDir, "calls.log")}"\ncat "${resp}"`);
}
function input() {
  const f = join(tmp("bedrock-in-"), "notes.txt");
  writeFileSync(f, TEXT);
  return f;
}

test("without --suggest-with-bedrock no AWS call is made", () => {
  const logDir = tmp("calls-");
  const bin = awsStub(logDir);
  const d = makeDict("");
  const r = build(["suggest", "--from", input(), "--dir", d], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.all);
  assert.ok(!existsSync(join(logDir, "calls.log")));
  cleanup(logDir, bin, d);
});

test("with the flag: suggestions are filled and marked UNVERIFIED; en is unchanged; product names keep their spelling", () => {
  const logDir = tmp("calls-");
  const bin = awsStub(logDir);
  const d = makeDict("");
  const r = build(["suggest", "--from", input(), "--dir", d, "--suggest-with-bedrock", "--model", MODEL, "--region", "ap-northeast-1"], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.all);
  const call = readFileSync(join(logDir, "calls.log"), "utf8");
  assert.match(call, /bedrock-runtime converse --model-id jp\.anthropic\.claude-haiku-4-5/);
  assert.match(call, /--region ap-northeast-1/);
  const rows = parseCsv(readFileSync(join(d, "terms.proposed.csv"), "utf8")).slice(1).map((x) => Object.fromEntries(COLUMNS.map((c, i) => [c, x.cells[i]])));
  const deck = rows.find((x) => x.en === "StreamDeck");
  assert.equal(deck.en, "StreamDeck");
  assert.equal(deck.ja, "StreamDeck", "product-like term: ja is forced to the English spelling");
  assert.equal(deck.reading, "ストリームデッキ");
  assert.match(deck.notes, /^UNVERIFIED \(bedrock jp\.anthropic\.claude-haiku/);
  const q = rows.find((x) => x.en === "quokkaform");
  assert.equal(q.ja, "クオッカフォーム");
  assert.equal(q.reading, "", "a reading with Latin letters is dropped");
  assert.ok(!rows.some((x) => x.en === "NotAnInput"));
  assert.ok(rows.every((x) => x.translate_en_ja === "" && x.polly_ja === ""), "flags are left for the reviewer");
  cleanup(logDir, bin, d);
});

test("the cost estimate is printed before the call and the usage after", () => {
  const logDir = tmp("calls-");
  const bin = awsStub(logDir);
  const d = makeDict("");
  const r = build(["suggest", "--from", input(), "--dir", d, "--suggest-with-bedrock", "--model", MODEL], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.match(r.err, /about \d+ input tokens and up to \d+ output tokens, about \$0\.\d+/);
  assert.match(r.err, /Bedrock usage: 400 input and 120 output tokens, about \$/);
  cleanup(logDir, bin, d);
});

test("an older AWS CLI without converse falls back to invoke-model", () => {
  const logDir = tmp("calls-");
  const resp = join(logDir, "resp.json");
  writeFileSync(resp, JSON.stringify({ content: [{ type: "text", text: JSON.stringify(ANSWER) }], usage: { input_tokens: 300, output_tokens: 90 } }));
  const bin = stubBin(
    "aws",
    `echo "$@" >> "${join(logDir, "calls.log")}"\ncase "$2" in converse) echo "aws: error: argument operation: Invalid choice" >&2; exit 252;; esac\nfor last; do :; done\ncp "${resp}" "$last"`,
  );
  const d = makeDict("");
  const r = build(["suggest", "--from", input(), "--dir", d, "--suggest-with-bedrock", "--model", MODEL], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.all);
  assert.match(readFileSync(join(logDir, "calls.log"), "utf8"), /invoke-model/);
  assert.match(r.err, /Bedrock usage: 300 input and 90 output tokens/);
  assert.match(readFileSync(join(d, "terms.proposed.csv"), "utf8"), /UNVERIFIED/);
  cleanup(logDir, bin, d);
});

test("a failing aws call is an error and writes no proposal", () => {
  const bin = stubBin("aws", `echo AccessDenied >&2\nexit 254`);
  const d = makeDict("");
  const r = build(["suggest", "--from", input(), "--dir", d, "--suggest-with-bedrock", "--model", MODEL], { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 1);
  assert.match(r.err, /converse failed/);
  assert.ok(!existsSync(join(d, "terms.proposed.csv")));
  cleanup(bin, d);
});

test("acceptSuggestions drops mismatched en, bad readings and bad ja", () => {
  const terms = [{ term: "StreamDeck" }, { term: "baseband" }];
  const m = acceptSuggestions(
    [
      { en: "streamdeck", ja: "x", reading: "エックス" },
      { en: "baseband", ja: 'a,"b', reading: "ベースバンド" },
    ],
    terms,
  );
  assert.ok(!m.has("streamdeck") && !m.has("StreamDeck"));
  assert.deepEqual(m.get("baseband"), { reading: "ベースバンド" });
  assert.deepEqual([...acceptSuggestions("nope", terms)], []);
});
test("price is known for Haiku models and unknown for others", () => {
  const req = buildRequest([{ term: "StreamDeck" }]);
  assert.equal(estimateCost(req, 1, MODEL, REPO).priced, true);
  assert.equal(estimateCost(req, 1, "jp.example.other-model", REPO).priced, false);
});
