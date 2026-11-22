#!/usr/bin/env node
// Checks relative link targets (file existence only, anchors ignored) in all tracked Markdown files. No dependencies, no network.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = execSync('git ls-files -co --exclude-standard -z', { cwd: root, encoding: 'utf8' })
  .split('\0').filter((f) => f.endsWith('.md') && existsSync(join(root, f)));
let bad = 0;
for (const f of files) {
  const text = readFileSync(join(root, f), 'utf8').replace(/```[\s\S]*?```/g, '');
  // Markdown links and images, and HTML <img src> / <a href> (GitHub allows them; the README landing image uses <img>).
  const targets = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g), ...text.matchAll(/<(?:img|a)\b[^>]*?\s(?:src|href)="([^"]+)"/g)];
  for (const m of targets) {
    const target = m[1];
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!path) continue;
    if (!existsSync(resolve(root, dirname(f), path))) {
      console.error(`${f}: broken link -> ${target}`);
      bad++;
    }
  }
}
console.log(`${files.length} Markdown files checked, ${bad} broken relative link(s).`);
process.exit(bad ? 1 : 0);
