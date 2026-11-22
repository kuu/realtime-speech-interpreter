// Browser listener. Fetches a subscriber token from the app's token endpoint, joins
// the LiveKit room, and plays the published Japanese audio.
//
// Config is injected at serve time via /config.json (LIVEKIT_URL + token endpoint),
// so the page has no hardcoded server details. For local testing you can also set
// window.LIVEKIT_URL / window.LIVEKIT_TOKEN before this script runs (captions are on there unless
// window.CAPTIONS === false).
//
// Live captions (config.json "captions": true): after Listen is pressed, the page also receives the caption
// data packets of the same room (no extra connection, no extra button). Japanese lines appear when their audio
// starts (Japanese speech is shown as said, on receipt, with a ― marker); the English source line appears as it is recognised (?source=off hides it). Everything is rendered
// with textContent only. Before Listen is pressed the page does nothing.

import {
  Room,
  RoomEvent,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";
import { parseEvent, parseSourceOption, createAssembler, createSourceAssembler, computeLayout } from "./captions.js";
import { LEGACY_CHANNEL, resolveChannel, pageText, createChannelSubscription, STATUS } from "./channel.js";

// Client-side delay (ms) applied to Japanese captions. The caption packet leaves the app when the chunk's
// first sample leaves the app's audio queue; the audio still passes the browser's jitter buffer and decoder.
// Measured on a local LiveKit server: captions shown on receipt led the audio by 165-271 ms (median 227),
// so they are held back by the rounded median (docs/architecture.md, "Caption timing").
const CAPTION_OFFSET_MS = 230;
// Sender and topic of the channel being played. Without a channel list in config.json this is today's single channel.
let channel = LEGACY_CHANNEL;
let listed = false; // config.json lists channels: the page subscribes to the chosen channel's track only

const listenBtn = document.getElementById("listen");
const statusEl = document.getElementById("status");
let room = null;
let captionsOn = false;
let captionsHandler = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

// Applies the chosen channel to the page: text that names the language, role styling and aria-live on the English
// channel. Nothing changes for the Japanese channel, so a one-channel page is today's page.
function applyChannelToPage(entry) {
  if (entry.targetLang !== "en") return; // only the English channel has its own roles and text
  const t = pageText(entry.targetLang);
  document.title = t.title;
  document.querySelector("h1").textContent = t.h1;
  document.querySelector("p").textContent = t.intro;
  listenBtn.textContent = t.button;
  document.documentElement.classList.add(`ch-${entry.targetLang}`);
  document.getElementById("captions-en").setAttribute("aria-live", "polite");
  document.getElementById("captions-ja").setAttribute("aria-live", "off");
}
// Picks the channel from config.json and ?ch=. false = the channel is not available (Listen stays disabled).
function chooseChannel(cfg) {
  const r = resolveChannel(cfg, window.location.search);
  if (!r.ok) {
    setStatus(STATUS.unavailable);
    listenBtn.disabled = true;
    return false;
  }
  channel = r.entry;
  listed = r.listed;
  applyChannelToPage(channel);
  return true;
}
// At load: one GET of config.json (the file Listen reads anyway) so an unknown ?ch= is reported before any click and a
// non-default single channel shows its own language. Any failure leaves the page as it is (the click path handles it).
let channelReady = true;
(async () => {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) channelReady = chooseChannel(await res.json());
  } catch {
    /* local test page or offline: the click path reports the problem */
  }
})();
async function getConnectionInfo() {
  // Prefer runtime config served alongside the page.
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      channelReady = chooseChannel(cfg);
      if (!channelReady) throw new Error(STATUS.unavailable);
      const tokenRes = await fetch(cfg.tokenEndpoint, { cache: "no-store" });
      const { token } = await tokenRes.json();
      captionsOn = cfg.captions === true;
      return { url: cfg.livekitUrl, token };
    }
  } catch {
    /* fall through to window globals for local testing */
  }
  if (window.LIVEKIT_URL && window.LIVEKIT_TOKEN) {
    captionsOn = window.CAPTIONS !== false;
    return { url: window.LIVEKIT_URL, token: window.LIVEKIT_TOKEN };
  }
  throw new Error("No connection info (config.json or window.LIVEKIT_* required)");
}

// ---- Captions layout: measured once when Listen is pressed, fixed afterwards ----
// Sizes come from the SMALL viewport height (svh), which does not change when the mobile browser's toolbar shows
// or hides, so nothing moves while reading. Re-measured only when the width or the svh changes (rotation, window
// resize), never on scroll or toolbar changes.
function measureSvh() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:0;box-sizing:border-box;height:100vh;height:100svh;padding-top:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const h = probe.offsetHeight;
  const inset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  // Without svh support (old browsers) 100vh is the LARGE viewport; use the smaller of it and the current height.
  const supported = window.CSS && CSS.supports && CSS.supports("height", "100svh");
  return { svh: supported ? h : Math.min(h, window.innerHeight), safeBottom: inset };
}
function applyLayout() {
  const root = document.documentElement;
  window.scrollTo(0, 0);
  const { svh, safeBottom } = measureSvh();
  const ja = document.getElementById("captions-ja");
  const en = document.getElementById("captions-en");
  const hint = document.querySelector(".hint");
  const L = computeLayout({
    svh,
    safeBottom,
    hintBottom: hint.getBoundingClientRect().bottom,
    jaFont: parseFloat(getComputedStyle(ja).fontSize),
    enFont: parseFloat(getComputedStyle(en).fontSize),
  });
  const set = (k, v) => root.style.setProperty(k, `${Math.round(v * 100) / 100}px`);
  set("--ja-top", L.jaTop);
  set("--ja-h", L.jaHeight);
  set("--en-top", L.enTop);
  set("--en-h", L.enHeight);
  root.dataset.layout = `${root.clientWidth}x${svh}`;
  return { w: root.clientWidth, svh };
}
function enterLiveLayout() {
  document.documentElement.classList.add("live");
  let last = applyLayout();
  let timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = measureSvh().svh;
      if (document.documentElement.clientWidth !== last.w || now !== last.svh) last = applyLayout();
    }, 150);
  });
}
// ---- Captions (plain text only: textContent, no markup is ever parsed) ----
function initCaptions() {
  enterLiveLayout();
  const showSource = parseSourceOption(window.location.search);
  // Positions are fixed by language (#captions-ja above, #captions-en below); the channel decides which one is the
  // translation (with as-said text) and which is the source.
  const transLang = channel.targetLang === "en" ? "en" : "ja";
  const sourceLang = transLang === "en" ? "ja" : "en";
  const trans = createAssembler({}, true, transLang);
  const srcAsm = createSourceAssembler({}, sourceLang);
  const sender = channel.publisher;
  const topicName = channel.topic;
  const blocks = [
    { el: document.getElementById("captions-ja"), asm: transLang === "ja" ? trans : srcAsm, role: transLang === "ja" ? "translation" : "source", nodes: new Map(), key: "" },
    { el: document.getElementById("captions-en"), asm: transLang === "en" ? trans : srcAsm, role: transLang === "en" ? "translation" : "source", nodes: new Map(), key: "" },
  ].filter((b) => showSource || b.role === "translation");
  function render() {
    const now = Date.now();
    for (const b of blocks) {
      b.asm.tick(now);
      const model = b.asm.model(now);
      const key = model.map((l) => `${l.id}\u0000${l.state}\u0000${l.said ? 1 : 0}\u0000${l.shown}`).join("\u0001");
      if (key === b.key) continue;
      b.key = key;
      const seen = new Set();
      model.forEach((l, i) => {
        seen.add(l.id);
        let node = b.nodes.get(l.id);
        if (!node) {
          node = document.createElement("div");
          b.nodes.set(l.id, node);
        }
        // l.shown = the text, with the display-only ― marker in front of Japanese shown as said
        if (node.textContent !== l.shown) node.textContent = l.shown;
        node.className = l.said ? `${l.state} said` : l.state;
        if (b.el.children[i] !== node) b.el.insertBefore(node, b.el.children[i] || null);
      });
      for (const [id, node] of b.nodes) {
        if (!seen.has(id)) {
          node.remove();
          b.nodes.delete(id);
        }
      }
      if (model.length > 0) {
        // Both areas appear together (fixed heights), so nothing moves when the second language arrives.
        for (const o of blocks) o.el.classList.add("on");
      }
      // Soft fade at the top only when older text is actually clipped.
      let h = 0;
      for (const c of b.el.children) h += c.offsetHeight;
      b.el.classList.toggle("clipped", h > b.el.clientHeight + 1);
    }
  }
  setInterval(render, 250);
  return (payload, participant, _kind, topic) => {
    if (topic !== topicName || !participant || participant.identity !== sender) return;
    const ev = parseEvent(payload);
    if (!ev) return;
    if (ev.kind === "speech") {
      // Japanese speech as said: no audio to wait for, shown on receipt.
      trans.push(ev, Date.now());
      render();
    } else if (ev.kind === "caption") {
      const accept = () => {
        trans.push(ev, Date.now());
        render();
      };
      if (CAPTION_OFFSET_MS > 0) setTimeout(accept, CAPTION_OFFSET_MS);
      else accept();
    } else if (showSource) {
      srcAsm.push(ev, Date.now());
      render();
    }
  };
}

// Attach the caption handler to a (new) room; the assemblers and the render tick are created once.
function startCaptions(r) {
  if (!captionsHandler) captionsHandler = initCaptions();
  r.on(RoomEvent.DataReceived, captionsHandler);
}

listenBtn.addEventListener("click", async () => {
  if (room || !channelReady) return;
  setStatus("Connecting…");
  try {
    const { url, token } = await getConnectionInfo();
    room = new Room();
    if (captionsOn) startCaptions(room);
    // With a channel list the page subscribes to the chosen channel's track only (not automatically): after Connected,
    // when the track is published later, and after a reconnect.
    const sub = listed ? createChannelSubscription(room, channel, (st) => setStatus(STATUS[st])) : null;
    room.on(RoomEvent.Connected, () => (sub ? sub.scan() : setStatus("Connected — waiting for audio…")));
    if (sub) {
      room.on(RoomEvent.TrackPublished, (pub, participant) => sub.onTrackPublished(pub, participant));
      room.on(RoomEvent.Reconnected, () => sub.scan());
    }
    room.on(RoomEvent.Disconnected, () => setStatus("Disconnected"));
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === "audio") {
        const el = track.attach();
        el.autoplay = true;
        document.body.appendChild(el);
        el.play().catch(() => setStatus("Tap the button again to start audio"));
        setStatus("Listening 🎧");
      }
    });
    await (listed ? room.connect(url, token, { autoSubscribe: false }) : room.connect(url, token));
    if (sub) sub.scan();
    listenBtn.textContent = "Listening…";
    listenBtn.disabled = true;
  } catch (e) {
    setStatus(`Error: ${e.message}`);
    room = null;
  }
});
