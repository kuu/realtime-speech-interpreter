// Channel selection for the listener page. Pure ES module (no DOM, no globals, no imports) so it can be unit-tested with
// node:test (app/test/page-channel.test.ts, page-subscription.test.ts).
//
// config.json without `channels` = today's page: one channel (Japanese audio from publisher-app on topic "captions"),
// automatic subscription. With `channels` the page plays one channel, chosen by ?ch=<id> (default: defaultChannel, else
// the first entry), and subscribes to that channel's track only.
export const LEGACY_CHANNEL = Object.freeze({
  id: "ja",
  sourceLang: "en",
  targetLang: "ja",
  track: "translation-audio",
  publisher: "publisher-app",
  topic: "captions",
});
const ID = /^[a-z]{2,3}$/;
const NAME = /^[A-Za-z0-9._:-]{1,64}$/;
/** Strict parse of ?ch=. Returns null when absent, "" when present but not a valid channel id. */
export function parseChannelOption(search) {
  const q = String(search || "").replace(/^\?/, "");
  for (const pair of q.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k === "ch") return ID.test(v) ? v : "";
  }
  return null;
}
function validEntry(e) {
  return (
    e && typeof e === "object" && ID.test(e.id) && ID.test(e.sourceLang) && ID.test(e.targetLang) &&
    NAME.test(e.track) && NAME.test(e.publisher) && NAME.test(e.topic)
  );
}
/** true when config.json carries a channel list (two lanes, or one non-default lane). */
export function hasChannels(cfg) {
  return !!cfg && Array.isArray(cfg.channels) && cfg.channels.length > 0;
}
/**
 * Which channel the page plays.
 * @returns {{ ok: true, entry: typeof LEGACY_CHANNEL, listed: boolean } | { ok: false }}
 */
export function resolveChannel(cfg, search) {
  const listed = hasChannels(cfg);
  const entries = listed ? cfg.channels.filter(validEntry) : [LEGACY_CHANNEL];
  if (entries.length === 0) return { ok: false };
  const want = parseChannelOption(search);
  if (want === null) {
    const def = listed && typeof cfg.defaultChannel === "string" ? entries.find((e) => e.id === cfg.defaultChannel) : undefined;
    return { ok: true, entry: def ?? entries[0], listed };
  }
  const hit = entries.find((e) => e.id === want);
  return hit ? { ok: true, entry: hit, listed } : { ok: false };
}
// Page text that names the language, by the channel's target language. Text only, not a control.
const TEXT = {
  ja: {
    title: "Live Translation \u2014 Japanese Audio",
    h1: "Live Translation (\u65e5\u672c\u8a9e\u97f3\u58f0)",
    intro: "Put on your headphones and press Listen to hear the Japanese translation.",
    button: "Listen / \u8074\u304f",
  },
  en: {
    title: "Live Translation \u2014 English Audio",
    h1: "Live Translation (English audio)",
    intro: "Put on your headphones and press Listen to hear the English translation.",
    button: "Listen",
  },
};
export function pageText(targetLang) {
  return TEXT[targetLang] ?? TEXT.ja;
}
export const STATUS = {
  unavailable: "This channel is not available",
  notLive: "Channel not live yet \u2014 waiting\u2026",
  waiting: "Connected \u2014 waiting for audio\u2026",
};
/**
 * Explicit subscription to one channel's track (used only when config.json lists channels; the page then connects with
 * autoSubscribe:false). `room` is a LiveKit Room (remoteParticipants Map, participants' trackPublications Map).
 * Call scan() after Connected and after Reconnected, and onTrackPublished() for every TrackPublished event.
 */
export function createChannelSubscription(room, entry, onState = () => {}) {
  const matches = (pub, participant) =>
    !!pub && !!participant && participant.identity === entry.publisher && pub.trackName === entry.track && pub.kind === "audio";
  const take = (pub) => {
    if (!pub.isSubscribed) pub.setSubscribed(true);
  };
  return {
    scan() {
      let found = false;
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (matches(pub, p)) {
            take(pub);
            found = true;
          }
        }
      }
      onState(found ? "waiting" : "notLive");
      return found;
    },
    onTrackPublished(pub, participant) {
      if (!matches(pub, participant)) return false;
      take(pub);
      onState("waiting");
      return true;
    },
  };
}
