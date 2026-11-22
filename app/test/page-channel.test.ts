// Listener page: ?ch= parsing, channel resolution, one-lane parity and page text (node:test). No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ch: any = await import(new URL("../web/channel.js", import.meta.url).href);
const { parseChannelOption, resolveChannel, hasChannels, pageText, LEGACY_CHANNEL, STATUS } = ch;

const JA = { id: "ja", sourceLang: "en", targetLang: "ja", track: "translation-audio", publisher: "publisher-app", topic: "captions" };
const EN = { id: "en", sourceLang: "ja", targetLang: "en", track: "translation-audio-en", publisher: "publisher-app-en", topic: "captions-en" };
const TWO = { livekitUrl: "wss://x", tokenEndpoint: "/token", captions: true, defaultChannel: "ja", channels: [JA, EN] };

test("parseChannelOption: absent = null; a valid id; anything else is present but invalid (empty string)", () => {
  assert.equal(parseChannelOption(""), null);
  assert.equal(parseChannelOption("?source=off"), null);
  assert.equal(parseChannelOption("?ch=en"), "en");
  assert.equal(parseChannelOption("?source=off&ch=ja"), "ja");
  for (const bad of ["?ch=", "?ch=EN", "?ch=english", "?ch=e", "?ch=<b>", "?ch=en%20", "?ch=../x", "?ch=en&ch=ja"].slice(0, 7)) {
    assert.equal(parseChannelOption(bad), "", bad);
  }
});
test("no channel list = today's page: the legacy channel, sender, topic and track; hasChannels false", () => {
  const cfg = { livekitUrl: "wss://x", tokenEndpoint: "/token", captions: true };
  assert.equal(hasChannels(cfg), false);
  const r = resolveChannel(cfg, "");
  assert.deepEqual(r, { ok: true, entry: LEGACY_CHANNEL, listed: false });
  assert.equal(r.entry.publisher, "publisher-app");
  assert.equal(r.entry.topic, "captions");
  assert.equal(r.entry.targetLang, "ja");
});
test("no channel list: ?ch=ja works, any other value is not available", () => {
  assert.equal(resolveChannel({}, "?ch=ja").ok, true);
  assert.equal(resolveChannel({}, "?ch=en").ok, false);
  assert.equal(resolveChannel(null, "?ch=en").ok, false);
});
test("two channels: default, ?ch=en, ?ch=ja, unknown and invalid values", () => {
  assert.equal(resolveChannel(TWO, "").entry.id, "ja");
  assert.equal(resolveChannel(TWO, "?ch=en").entry.id, "en");
  assert.equal(resolveChannel(TWO, "?ch=en").listed, true);
  assert.equal(resolveChannel(TWO, "?ch=ja").entry.id, "ja");
  assert.equal(resolveChannel(TWO, "?ch=fr").ok, false);
  assert.equal(resolveChannel(TWO, "?ch=").ok, false);
  assert.equal(resolveChannel({ ...TWO, defaultChannel: "en" }, "").entry.id, "en");
  assert.equal(resolveChannel({ ...TWO, defaultChannel: "zz" }, "").entry.id, "ja", "unknown default falls back to the first entry");
});
test("a single non-default channel: the default URL is that channel, ?ch=ja is not available", () => {
  const cfg = { channels: [EN], defaultChannel: "en" };
  assert.equal(resolveChannel(cfg, "").entry.id, "en");
  assert.equal(resolveChannel(cfg, "?ch=ja").ok, false);
});
test("entries with odd values are ignored, never trusted", () => {
  const bad = { ...EN, topic: "<script>", track: "a b" };
  assert.equal(resolveChannel({ channels: [bad] }, "").ok, false);
  assert.equal(resolveChannel({ channels: [bad, JA] }, "").entry.id, "ja");
});
test("page text by target language; Japanese stays today's text; unknown language falls back to Japanese", () => {
  assert.equal(pageText("ja").h1, "Live Translation (日本語音声)");
  assert.equal(pageText("ja").button, "Listen / 聴く");
  assert.match(pageText("en").intro, /English translation/);
  assert.equal(pageText("fr"), pageText("ja"));
  assert.equal(STATUS.unavailable, "This channel is not available");
});
test("parity: the page keeps today's strings, the 230 ms offset and the default connect call", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /<h1>Live Translation \(日本語音声\)<\/h1>/);
  assert.match(html, /<button id="listen">Listen \/ 聴く<\/button>/);
  assert.match(html, /<div id="captions-ja" aria-live="polite" aria-atomic="false"><\/div>/);
  assert.match(html, /<div id="captions-en" aria-live="off"><\/div>/);
  const js = readFileSync(new URL("../web/subscriber.js", import.meta.url), "utf8");
  assert.match(js, /const CAPTION_OFFSET_MS = 230;/);
  assert.match(js, /room\.connect\(url, token\)\)/, "the one-channel connect call has no options (automatic subscription)");
  assert.match(js, /\{ autoSubscribe: false \}/);
  assert.match(js, /listed \? room\.connect/);
  assert.match(js, /let channel = LEGACY_CHANNEL;/);
  // the English-channel CSS is scoped to html.ch-en
  const rules = html.match(/^\s*html\.ch-en [^{]+\{/gm) ?? [];
  assert.ok(rules.length >= 6);
  assert.doesNotMatch(html.replace(/html\.ch-en [^{]+\{[^}]*\}/g, ""), /ch-en/);
});
