// Listener page: explicit subscription to the chosen channel's track with a fake room (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
const ch: any = await import(new URL("../web/channel.js", import.meta.url).href);
const { createChannelSubscription } = ch;

const JA = { id: "ja", sourceLang: "en", targetLang: "ja", track: "translation-audio", publisher: "publisher-app", topic: "captions" };
const EN = { id: "en", sourceLang: "ja", targetLang: "en", track: "translation-audio-en", publisher: "publisher-app-en", topic: "captions-en" };

function pub(trackName: string, kind = "audio") {
  return { trackName, kind, isSubscribed: false, calls: [] as boolean[], setSubscribed(v: boolean) { this.calls.push(v); this.isSubscribed = v; } };
}
function participant(identity: string, pubs: any[]) {
  return { identity, trackPublications: new Map(pubs.map((p, i) => [`t${i}`, p])) };
}
function room(parts: any[]) {
  return { remoteParticipants: new Map(parts.map((p, i) => [`p${i}`, p])) };
}

test("a late joiner subscribes to the selected channel's track only; the other track gets no bytes", () => {
  const jaTrack = pub("translation-audio");
  const enTrack = pub("translation-audio-en");
  const r = room([participant("publisher-app", [jaTrack]), participant("publisher-app-en", [enTrack])]);
  const states: string[] = [];
  const sub = createChannelSubscription(r, EN, (s: string) => states.push(s));
  assert.equal(sub.scan(), true);
  assert.deepEqual(enTrack.calls, [true]);
  assert.deepEqual(jaTrack.calls, [], "the other channel is never subscribed");
  assert.deepEqual(states, ["waiting"]);
});
test("channel 1 selected: only channel 1's track", () => {
  const jaTrack = pub("translation-audio");
  const enTrack = pub("translation-audio-en");
  const sub = createChannelSubscription(room([participant("publisher-app", [jaTrack]), participant("publisher-app-en", [enTrack])]), JA);
  sub.scan();
  assert.deepEqual(jaTrack.calls, [true]);
  assert.deepEqual(enTrack.calls, []);
});
test("the track is not published yet: 'not live', then TrackPublished subscribes", () => {
  const r = room([participant("publisher-app", [pub("translation-audio")])]);
  const states: string[] = [];
  const sub = createChannelSubscription(r, EN, (s: string) => states.push(s));
  assert.equal(sub.scan(), false);
  assert.deepEqual(states, ["notLive"]);
  const late = pub("translation-audio-en");
  assert.equal(sub.onTrackPublished(pub("translation-audio"), participant("publisher-app", [])), false, "the other channel's track is ignored");
  assert.equal(sub.onTrackPublished(late, participant("publisher-app-en", [late])), true);
  assert.deepEqual(late.calls, [true]);
  assert.deepEqual(states, ["notLive", "waiting"]);
});
test("a reconnect scans again and re-subscribes; an already subscribed track is not touched twice", () => {
  const t = pub("translation-audio-en");
  const sub = createChannelSubscription(room([participant("publisher-app-en", [t])]), EN);
  sub.scan();
  sub.scan();
  assert.deepEqual(t.calls, [true], "one setSubscribed while subscribed");
  t.isSubscribed = false; // the reconnect dropped it
  sub.scan();
  assert.deepEqual(t.calls, [true, true]);
});
test("a track with the right name from another participant, or a non-audio track, is not taken", () => {
  const imposter = pub("translation-audio-en");
  const video = pub("translation-audio-en", "video");
  const sub = createChannelSubscription(room([participant("someone-else", [imposter]), participant("publisher-app-en", [video])]), EN);
  assert.equal(sub.scan(), false);
  assert.deepEqual(imposter.calls, []);
  assert.deepEqual(video.calls, []);
});
