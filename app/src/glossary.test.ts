import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTerminologyCsv, glossaryLines, loadDeployedGlossary } from "./glossary.js";

test("parse: header, BOM, CRLF, blank lines", () => {
  const csv = "\uFEFFen,ja\r\nMediaLive,MediaLive\r\n\r\nlaunch,ローンチ\r\n";
  assert.deepEqual(parseTerminologyCsv(csv), [
    ["MediaLive", "MediaLive"],
    ["launch", "ローンチ"],
  ]);
});

test("parse: quoted comma and escaped quote", () => {
  const csv = 'en,ja\n"a, b","x, y"\n"say ""hi""",こんにちは\n';
  assert.deepEqual(parseTerminologyCsv(csv), [
    ["a, b", "x, y"],
    ['say "hi"', "こんにちは"],
  ]);
});

test("parse: duplicate key keeps first (case-insensitive); rows without ja are skipped; no trailing newline", () => {
  const csv = "en,ja\nPackager,パッケージャー\npackager,別\nonly\nlast,最後";
  assert.deepEqual(parseTerminologyCsv(csv), [
    ["Packager", "パッケージャー"],
    ["last", "最後"],
  ]);
});

test("parse: empty and header-only input", () => {
  assert.deepEqual(parseTerminologyCsv(""), []);
  assert.deepEqual(parseTerminologyCsv("en,ja\n"), []);
});

test("glossaryLines keeps order", () => {
  assert.equal(glossaryLines([["b", "B"], ["a", "A"]]), "b = B\na = A");
});

function fakeClient(res: unknown | Error, delayMs = 0) {
  return {
    send: async (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) => {
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          opts?.abortSignal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      if (res instanceof Error) throw res;
      return res;
    },
  };
}
const okFetch = (body: string, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });
const loc = { TerminologyDataLocation: { Location: "https://example.invalid/x" } };

test("load: success", async () => {
  const g = await loadDeployedGlossary(fakeClient(loc), "t", okFetch("en,ja\nA,あ\n"), 1000);
  assert.deepEqual(g, [["A", "あ"]]);
});

test("load: API error rejects", async () => {
  await assert.rejects(loadDeployedGlossary(fakeClient(new Error("AccessDenied")), "t", okFetch(""), 1000), /AccessDenied/);
});

test("load: HTTP 403 rejects", async () => {
  await assert.rejects(loadDeployedGlossary(fakeClient(loc), "t", okFetch("", false, 403), 1000), /HTTP 403/);
});

test("load: empty CSV rejects", async () => {
  await assert.rejects(loadDeployedGlossary(fakeClient(loc), "t", okFetch("en,ja\n"), 1000), /no entries/);
});

test("load: no location rejects; empty name rejects", async () => {
  await assert.rejects(loadDeployedGlossary(fakeClient({}), "t", okFetch(""), 1000), /no download location/);
  await assert.rejects(loadDeployedGlossary(fakeClient(loc), "", okFetch(""), 1000), /no terminology name/);
});

test("load: timeout rejects", async () => {
  await assert.rejects(loadDeployedGlossary(fakeClient(loc, 500), "t", okFetch("en,ja\nA,あ"), 30), /timed out/);
});
