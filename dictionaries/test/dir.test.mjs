import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDictionaryDir, settingFromEnv } from "../lib/dir.mjs";
import { build, cleanup, tmp } from "./helpers.mjs";

function fakeRoot({ local }) {
  const root = tmp("dict-root-");
  mkdirSync(join(root, "dictionaries", "example"), { recursive: true });
  if (local) mkdirSync(join(root, "dictionaries", "local"));
  return root;
}

test("example is the default when there is no local dir", () => {
  const root = fakeRoot({ local: false });
  const r = resolveDictionaryDir({ root });
  assert.equal(r.source, "example");
  assert.equal(r.dir, join(root, "dictionaries", "example"));
  cleanup(root);
});
test("local beats example", () => {
  const root = fakeRoot({ local: true });
  assert.equal(resolveDictionaryDir({ root }).source, "local");
  cleanup(root);
});
test("an explicit setting beats local", () => {
  const root = fakeRoot({ local: true });
  const other = tmp("dict-other-");
  const r = resolveDictionaryDir({ root, setting: other });
  assert.deepEqual(r, { dir: other, source: "setting" });
  cleanup(root, other);
});
test("a relative setting resolves against the root", () => {
  const root = fakeRoot({ local: false });
  mkdirSync(join(root, "mine"));
  assert.equal(resolveDictionaryDir({ root, setting: "mine" }).dir, join(root, "mine"));
  cleanup(root);
});
test("a set but missing directory is an error, never a fallback", () => {
  const root = fakeRoot({ local: true });
  assert.throws(() => resolveDictionaryDir({ root, setting: "/nonexistent/dict-dir" }), /does not exist/);
  cleanup(root);
});
test("DICTIONARY_DIR wins over the DICT_DIR alias", () => {
  assert.equal(settingFromEnv({ DICTIONARY_DIR: "a", DICT_DIR: "b" }), "a");
  assert.equal(settingFromEnv({ DICT_DIR: "b" }), "b");
  assert.equal(settingFromEnv({}), "");
});
test("build.mjs where prints dir and source", () => {
  const root = fakeRoot({ local: true });
  const r = build(["where", "--root", root]);
  assert.equal(r.status, 0);
  assert.equal(r.out.trim(), `${join(root, "dictionaries", "local")}\tlocal`);
  cleanup(root);
});
test("write commands refuse the example without --dir and point at init", () => {
  const root = fakeRoot({ local: false });
  const r = build(["generate", "--root", root]);
  assert.equal(r.status, 1);
  assert.match(r.err, /build\.mjs init/);
  cleanup(root);
});
