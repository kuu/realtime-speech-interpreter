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

// Client-side delay (ms) applied to Japanese captions. The caption packet leaves the app when the chunk's
// first sample leaves the app's audio queue; the audio still passes the browser's jitter buffer and decoder.
// Measured on a local LiveKit server: captions shown on receipt led the audio by 165-271 ms (median 227),
// so they are held back by the rounded median (docs/architecture.md, "Caption timing").
const CAPTION_OFFSET_MS = 230;
const CAPTION_SENDER = "publisher-app";
const CAPTION_TOPIC = "captions";

const listenBtn = document.getElementById("listen");
const statusEl = document.getElementById("status");
let room = null;
let captionsOn = false;
let captionsHandler = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function getConnectionInfo() {
  // Prefer runtime config served alongside the page.
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
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
  const ja = createAssembler();
  const en = createSourceAssembler();
  const blocks = [
    { el: document.getElementById("captions-ja"), asm: ja, nodes: new Map(), key: "" },
    ...(showSource ? [{ el: document.getElementById("captions-en"), asm: en, nodes: new Map(), key: "" }] : []),
  ];
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
    if (topic !== CAPTION_TOPIC || !participant || participant.identity !== CAPTION_SENDER) return;
    const ev = parseEvent(payload);
    if (!ev) return;
    if (ev.kind === "speech") {
      // Japanese speech as said: no audio to wait for, shown on receipt.
      ja.push(ev, Date.now());
      render();
    } else if (ev.kind === "caption") {
      const accept = () => {
        ja.push(ev, Date.now());
        render();
      };
      if (CAPTION_OFFSET_MS > 0) setTimeout(accept, CAPTION_OFFSET_MS);
      else accept();
    } else if (showSource) {
      en.push(ev, Date.now());
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
  if (room) return;
  setStatus("Connecting…");
  try {
    const { url, token } = await getConnectionInfo();
    room = new Room();
    if (captionsOn) startCaptions(room);
    room.on(RoomEvent.Connected, () => setStatus("Connected — waiting for audio…"));
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
    await room.connect(url, token);
    listenBtn.textContent = "Listening…";
    listenBtn.disabled = true;
  } catch (e) {
    setStatus(`Error: ${e.message}`);
    room = null;
  }
});
