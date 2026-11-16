import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, cleanup, tmp } from "./helpers.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, stdio: "pipe" });

/** A throwaway git repo with a copy of the check script and the shared patterns. */
function fakeRepo() {
  const root = tmp("publishable-");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dictionaries", "local"), { recursive: true });
  copyFileSync(join(REPO, "scripts", "check-publishable.mjs"), join(root, "scripts", "check-publishable.mjs"));
  copyFileSync(join(REPO, "scripts", "forbidden-patterns.txt"), join(root, "scripts", "forbidden-patterns.txt"));
  writeFileSync(join(root, ".gitignore"), "dictionaries/local/\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "dictionaries", "local", "terms.csv"), "en\nHLS\n");
  git(root, "init", "-q", "-b", "main");
  return root;
}
const check = (root, ...a) => spawnSync("node", ["scripts/check-publishable.mjs", ...a], { cwd: root, encoding: "utf8" });

test("an untracked, ignored local dictionary passes", () => {
  const root = fakeRepo();
  git(root, "add", ".gitignore", "README.md", "scripts");
  git(root, "commit", "-q", "-m", "init");
  const r = check(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  cleanup(root);
});
test("a tracked file under dictionaries/local/ fails (git add -f)", () => {
  const root = fakeRepo();
  git(root, "add", ".gitignore", "README.md", "scripts");
  git(root, "add", "-f", "dictionaries/local/terms.csv");
  git(root, "commit", "-q", "-m", "oops");
  const r = check(root, "--no-history");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /dictionaries\/local\/terms\.csv: \[your own dictionary\]/);
  cleanup(root);
});
test("a file that was committed once is flagged in the history", () => {
  const root = fakeRepo();
  git(root, "add", ".gitignore", "README.md", "scripts");
  git(root, "add", "-f", "dictionaries/local/terms.csv");
  git(root, "commit", "-q", "-m", "oops");
  git(root, "rm", "-q", "--cached", "dictionaries/local/terms.csv");
  git(root, "commit", "-q", "-m", "remove");
  const r = check(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /history: \[your own dictionary\] dictionaries\/local\/terms\.csv/);
  cleanup(root);
});
test("if .gitignore stops ignoring the folder, the untracked file is flagged", () => {
  const root = fakeRepo();
  writeFileSync(join(root, ".gitignore"), "");
  git(root, "add", ".gitignore", "README.md", "scripts");
  git(root, "commit", "-q", "-m", "init");
  const r = check(root, "--no-history");
  assert.equal(r.status, 1);
  cleanup(root);
});
