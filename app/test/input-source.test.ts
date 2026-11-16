// One input at a time (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectSource } from "../src/input-source.js";

test("file wins, then browser, then srt", () => {
  assert.equal(selectSource({ inputFile: "/tmp/x.raw", source: "browser" }), "file");
  assert.equal(selectSource({ inputFile: "/tmp/x.raw", source: "srt" }), "file");
  assert.equal(selectSource({ source: "browser" }), "browser");
  assert.equal(selectSource({ source: "srt" }), "srt");
  assert.equal(selectSource({ inputFile: "", source: "srt" }), "srt");
});

test("main.ts starts the SRT listener only on the non-browser path and the ingest only for browser", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // the browser source returns before the SRT listener is built
  const browserReturn = src.indexOf("if (!inputFile && ingest) return ingest.session.nextSession();");
  const srtStart = src.indexOf("startSrtListener()");
  assert.ok(browserReturn > 0 && srtStart > browserReturn);
  assert.match(src, /const ingest = kind === "browser" \? new BrowserIngest\(\) : undefined;/);
});

test("INPUT_SOURCE defaults to srt and rejects junk with a warning", async () => {
  const run = (v: string | undefined) => {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.INPUT_SOURCE;
    if (v !== undefined) env.INPUT_SOURCE = v;
    return env;
  };
  const { spawnSync } = await import("node:child_process");
  const probe = (v: string | undefined) =>
    spawnSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/config.ts").then((m)=>console.log("SRC="+m.config.input.source+" GRACE="+m.config.ingest.sessionGraceSec+" DB="+m.config.ingest.silenceDb+" SEC="+m.config.ingest.silenceSec+" ROOM="+m.config.ingest.room))'], {
      env: run(v) as NodeJS.ProcessEnv, encoding: "utf8", cwd: new URL("..", import.meta.url).pathname,
    });
  assert.match(probe(undefined).stdout, /SRC=srt GRACE=60 DB=-60 SEC=30 ROOM=translation-ingest/);
  assert.match(probe("browser").stdout, /SRC=browser/);
  const bad = probe("usb");
  assert.match(bad.stdout, /SRC=srt/);
  assert.match(bad.stderr, /INPUT_SOURCE/);
});
