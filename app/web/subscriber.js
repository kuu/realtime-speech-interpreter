// Browser listener. Fetches a subscriber token from the app's token endpoint, joins
// the LiveKit room, and plays the published Japanese audio.
//
// Config is injected at serve time via /config.json (LIVEKIT_URL + token endpoint),
// so the page has no hardcoded server details. For local testing you can also set
// window.LIVEKIT_URL / window.LIVEKIT_TOKEN before this script runs.

import {
  Room,
  RoomEvent,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

const listenBtn = document.getElementById("listen");
const statusEl = document.getElementById("status");
let room = null;

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
      return { url: cfg.livekitUrl, token };
    }
  } catch {
    /* fall through to window globals for local testing */
  }
  if (window.LIVEKIT_URL && window.LIVEKIT_TOKEN) {
    return { url: window.LIVEKIT_URL, token: window.LIVEKIT_TOKEN };
  }
  throw new Error("No connection info (config.json or window.LIVEKIT_* required)");
}

listenBtn.addEventListener("click", async () => {
  if (room) return;
  setStatus("Connecting…");
  try {
    const { url, token } = await getConnectionInfo();
    room = new Room();
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
