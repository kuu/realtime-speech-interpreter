import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { loadModel, generate } from "./render-architecture.mjs";

const model = loadModel();

test("every edge endpoint and node group exists", () => {
  const nodes = new Set(model.nodes.map((n) => n.id));
  const groups = new Set(model.groups.map((g) => g.id));
  assert.equal(nodes.size, model.nodes.length, "duplicate node ids");
  for (const e of model.edges) {
    assert.ok(nodes.has(e.from), `${e.id}: unknown from ${e.from}`);
    assert.ok(nodes.has(e.to), `${e.id}: unknown to ${e.to}`);
  }
  for (const n of model.nodes) assert.ok(groups.has(n.group), `${n.id}: unknown group ${n.group}`);
  for (const g of model.groups) if (g.parent) assert.ok(groups.has(g.parent), `${g.id}: unknown parent`);
});

test("step numbers are unique and contiguous from 1, variants point at a step", () => {
  const steps = model.edges.filter((e) => e.step).map((e) => e.step).sort((a, b) => a - b);
  assert.deepEqual(steps, steps.map((_, i) => i + 1));
  for (const e of model.edges.filter((x) => x.variantOf)) assert.ok(steps.includes(e.variantOf));
  for (const e of model.edges.filter((x) => x.step)) assert.ok(e.text, `step ${e.step} has no text`);
});

test("generated files are up to date", () => {
  for (const f of generate(model)) {
    assert.ok(existsSync(f.path), `${f.path} missing`);
    assert.equal(readFileSync(f.path, "utf8"), f.content, `${f.path} is out of date: run node scripts/render-architecture.mjs`);
  }
});

test("drawio ids are unique and every edge source/target exists", () => {
  const xml = readFileSync(new URL("../docs/architecture.drawio", import.meta.url), "utf8");
  const ids = [...xml.matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate mxCell ids");
  const set = new Set(ids);
  for (const m of xml.matchAll(/(?:source|target|parent)="([^"]+)"/g)) assert.ok(set.has(m[1]), `dangling reference ${m[1]}`);
  assert.ok(!/\b(host|agent|etag|modified)=/.test(xml.split("<diagram")[0]), "mxfile carries host metadata");
});

test("svg has title, desc, white background and no external references", () => {
  const svg = readFileSync(new URL("../docs/architecture.svg", import.meta.url), "utf8");
  assert.match(svg, /<title id="title">/);
  assert.match(svg, /<desc id="desc">/);
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#FFFFFF"\/>/);
  assert.ok(!/(href|src)=|url\(http|@import/.test(svg));
});
