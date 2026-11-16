// Static checks of the publisher page sources: no storage of the code, no third-party origin (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../publisher/${f}`, import.meta.url), "utf8");
const FILES = ["publish.html", "publisher.js", "publisher-core.js", "publisher.css"];

test("the page never stores the code or writes HTML", () => {
  for (const f of ["publisher.js", "publisher-core.js"]) {
    const src = read(f);
    for (const bad of ["localStorage", "sessionStorage", "document.cookie", "location.hash", "location.search", "history.", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      assert.ok(!src.includes(bad), `${f} uses ${bad}`);
    }
  }
});

test("the code is posted in the body, never put in a URL", () => {
  const src = read("publisher.js");
  assert.match(src, /method: "POST"/);
  assert.match(src, /fetch\(config\.publisherTokenEndpoint, \{/);
  assert.ok(!/fetch\([^)]*code/.test(src.replace(/JSON\.stringify\(\{ code: session\.getCode\(\) \}\)/, "")));
  assert.ok(!/\?code=|`[^`]*\$\{[^}]*code/i.test(src));
});

test("the form has one password field, no form element and no name", () => {
  const html = read("publish.html");
  assert.match(html, /<input id="code" type="password" autocomplete="off"/);
  assert.ok(!/<form/i.test(html));
  for (const tag of html.match(/<(input|select|button)\b[^>]*>/gi) ?? []) assert.ok(!/\sname=/i.test(tag), tag);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /noindex/);
});

test("no script, import or link to another origin; no inline script or style", () => {
  for (const f of FILES) {
    const src = read(f);
    assert.ok(!/https?:\/\//.test(src), `${f} mentions an absolute URL`);
    assert.ok(!/\/\/cdn\./.test(src));
  }
  const html = read("publish.html");
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), "inline script");
  assert.ok(!/\sstyle=/i.test(html) && !/<style/i.test(html), "inline style");
  for (const m of read("publisher.js").matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\//);
});
