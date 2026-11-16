#!/usr/bin/env node
// Checks docs/architecture.drawio.svg: it exists, is well-formed XML, embeds an uncompressed <mxfile>
// (the editable diagram), every resIcon / grIcon / shape in it is an mxgraph.aws4 name (plus a short list of
// generic shapes for non-AWS components, NON_AWS_SHAPES below), and the embedded
// metadata has no machine data (host other than app.diagrams.net, agent, etag, modified).
// No dependencies, no draw.io needed. Usage: node scripts/check-diagram.mjs [FILE]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(new URL('..', import.meta.url).pathname);
const file = resolve(process.argv[2] ?? `${root}/docs/architecture.drawio.svg`);
const errors = [];
const fail = (m) => errors.push(m);

let svg = '';
try { svg = readFileSync(file, 'utf8'); } catch { fail(`${file} does not exist`); }

const unescape = (s) => s.replace(/&#10;/g, '\n').replace(/&#13;/g, '\r').replace(/&#9;/g, '\t')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Minimal well-formedness check: tags nest and close, one root element. Skips comments, CDATA, PIs and the DOCTYPE.
function wellFormed(text) {
  const stack = [];
  let roots = 0;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (text.slice(last, m.index).includes('<')) return 'stray "<" in text';
    last = re.lastIndex;
    if (!m[2]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return `unexpected closing tag </${m[2]}>`; }
    else if (!m[4]) { if (!stack.length) roots++; stack.push(m[2]); }
    else if (!stack.length) roots++;
  }
  if (text.slice(last).includes('<')) return 'unparsed "<" at the end';
  if (stack.length) return `unclosed <${stack.pop()}>`;
  return roots === 1 ? null : `${roots} root elements`;
}

if (svg) {
  const bad = wellFormed(svg);
  if (bad) fail(`not well-formed XML: ${bad}`);
  if (!/<svg[\s>]/.test(svg)) fail('no <svg> root element');
  const attr = svg.match(/<svg\b[^>]*?\scontent="([^"]*)"/);
  if (!attr) fail('no content="..." attribute: the draw.io diagram is not embedded (export with "Include a copy of my diagram")');
  else {
    const xml = unescape(attr[1]);
    if (!/^\s*<mxfile[\s>]/.test(xml)) fail('the embedded content does not start with <mxfile>');
    const wf = wellFormed(xml);
    if (wf) fail(`the embedded diagram is not well-formed XML: ${wf}`);
    if (/<diagram\b[^>]*>\s*[A-Za-z0-9+/=]{40,}\s*<\/diagram>/.test(xml)) fail('the embedded diagram is compressed; run scripts/export-diagram.sh (uncompressed XML keeps git diffs readable)');
    if (!/<mxCell\b/.test(xml)) fail('the embedded diagram has no cells');
    const host = xml.match(/<mxfile\b[^>]*?\bhost="([^"]*)"/);
    if (host && host[1] !== 'app.diagrams.net') fail(`mxfile host is "${host[1]}"; run scripts/scrub-drawio.sh`);
    if (/<mxfile\b[^>]*?\b(agent|etag|modified)=/.test(xml)) fail('mxfile has agent/etag/modified; run scripts/scrub-drawio.sh');
    let icons = 0;
    for (const m of xml.matchAll(/\b(resIcon|grIcon)=([^;"]+)/g)) {
      icons++;
      if (!/^mxgraph\.aws4\.[a-z0-9_]+$/.test(m[2])) fail(`${m[1]}=${m[2]} is not an mxgraph.aws4 icon name`);
    }
    // Non-AWS things at the venue have no AWS icon; these built-in draw.io shapes are allowed for them.
    const NON_AWS_SHAPES = new Set(['mxgraph.office.devices.microphone']);
    for (const m of xml.matchAll(/\bshape=([^;"]+)/g)) {
      if (m[1].startsWith('mxgraph.') && !m[1].startsWith('mxgraph.aws4.') && !NON_AWS_SHAPES.has(m[1])) {
        fail(`shape=${m[1]} is not from the AWS 2021+ library (mxgraph.aws4); add it to NON_AWS_SHAPES only for a non-AWS component`);
      }
    }
    if (!icons) fail('no resIcon/grIcon found: the diagram has no AWS icons');
    if (/data:image\//.test(xml)) fail('the diagram embeds bitmap images; use the built-in mxgraph.aws4 shapes');
  }
  if (/<image\b/.test(svg)) fail('the SVG contains <image> elements (embedded bitmaps)');
}

if (errors.length) {
  for (const e of errors) console.error(`check-diagram: ${e}`);
  process.exit(1);
}
console.log(`check-diagram: ${file.replace(root + '/', '')} OK (${svg.length} bytes)`);
