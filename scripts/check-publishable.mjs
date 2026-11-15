#!/usr/bin/env node
// Fails (exit 1) if a forbidden pattern appears in the files git would publish
// (tracked + untracked, non-ignored) or in the git history of this repository.
//
//   node scripts/check-publishable.mjs              # working tree + history
//   node scripts/check-publishable.mjs --no-history # working tree only
//   node scripts/check-publishable.mjs --history-only
//
// Patterns: scripts/forbidden-patterns.txt (shared, committed) and optionally
// scripts/forbidden-patterns.local.txt (gitignored; put your real account ID, IPs,
// name and e-mail there so they are checked without being published).
// File format: one JavaScript regular expression per line (matched case-insensitively),
// `#` starts a comment, a line starting with `!` is an allow-list regex applied to the
// matched text. Write real values in a self-non-matching form, e.g. `1234[5]6`, so the
// pattern file does not trip its own check.
// Built in: any public-looking IPv4 address (documentation ranges 192.0.2.0/24,
// 198.51.100.0/24, 203.0.113.0/24, loopback, private ranges and 0.0.0.0 are allowed).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const historyOnly = args.includes("--history-only");
const noHistory = args.includes("--no-history");

function loadPatterns(file) {
  const deny = [];
  const allow = [];
  if (!existsSync(file)) return { deny, allow };
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) allow.push(new RegExp(line.slice(1), "i"));
    else deny.push({ src: line, re: new RegExp(line, "gi"), file: relative(root, file) });
  }
  return { deny, allow };
}
const shared = loadPatterns(join(here, "forbidden-patterns.txt"));
const local = loadPatterns(join(here, "forbidden-patterns.local.txt"));
const DENY = [...shared.deny, ...local.deny];
const ALLOW = [...shared.allow, ...local.allow];
if (DENY.length === 0) {
  console.error("check-publishable: no patterns loaded (scripts/forbidden-patterns.txt missing or empty)");
  process.exit(2);
}

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g;
function publicIp(m) {
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 127 || a === 10 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function scanText(text, skipIp) {
  const hits = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.length > 5000) line = line.slice(0, 5000);
    for (const p of DENY) {
      p.re.lastIndex = 0;
      for (const m of line.matchAll(p.re)) {
        if (ALLOW.some((a) => a.test(m[0]))) continue;
        hits.push({ line: i + 1, what: p.src, text: m[0] });
      }
    }
    if (!skipIp) {
      for (const m of line.matchAll(IPV4)) {
        if (publicIp(m) && !ALLOW.some((a) => a.test(m[0]))) hits.push({ line: i + 1, what: "public IPv4 address", text: m[0] });
      }
    }
  });
  return hits;
}

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    const acc = [];
    // Without git there is no .gitignore handling: skip what .gitignore lists for generated or local files.
    const skip = new Set([".git", "node_modules", "dist", "cdk.out", ".cdk.staging", "cdk.context.json", "__pycache__", ".DS_Store", ".env"]);
    const skipPath = new Set(["e2e/runs", "samples/out"]);
    const walk = (d) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const rel = d ? `${d}/${e.name}` : e.name;
        if (skipPath.has(rel)) continue;
        if (e.isDirectory()) walk(rel);
        else acc.push(rel);
      }
    };
    walk("");
    return acc;
  }
}

let findings = 0;
const report = (where, h) => {
  findings++;
  console.log(`${where}:${h.line}: [${h.what}] ${JSON.stringify(h.text)}`);
};

if (!historyOnly) {
  const files = listFiles();
  let scanned = 0;
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 5_000_000) continue;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    const lock = /(^|\/)package-lock\.json$/.test(f);
    for (const h of scanText(buf.toString("utf8"), lock)) report(f, h);
  }
  console.log(`check-publishable: scanned ${scanned} files in the working tree`);
}

if (!noHistory) {
  if (!existsSync(join(root, ".git"))) {
    console.log("check-publishable: no .git directory, history check skipped");
  } else {
    let log = "";
    try {
      log = execFileSync("git", ["log", "--all", "--no-color", "-p", "--format=%x01%H %an <%ae> | %cn <%ce>%n%B"], { cwd: root, maxBuffer: 1 << 30 }).toString("utf8");
    } catch (e) {
      if (!String(e.stderr ?? e.message).includes("does not have any commits")) throw e;
    }
    let commit = "", n = 0, file = "";
    const chunks = log.split("\x01").filter(Boolean);
    for (const c of chunks) {
      n++;
      const nl = c.indexOf("\n");
      commit = c.slice(0, nl).slice(0, 80);
      const body = c.slice(nl + 1);
      for (const h of scanText(c.slice(0, nl) + "\n" + body, false)) report(`history ${commit.slice(0, 12)}`, h);
    }
    console.log(`check-publishable: scanned ${n} commit(s) in the history`);
  }
}

if (findings > 0) {
  console.error(`check-publishable: FAILED, ${findings} finding(s)`);
  process.exit(1);
}
console.log("check-publishable: OK");
