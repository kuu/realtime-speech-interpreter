// Speaker page: sends the microphone to the ingest room. The code is typed into one password field, posted to the
// token endpoint, and kept only in a closure (publisher-core.js createSession). Nothing is stored in the browser.
import { Room, RoomEvent, DisconnectReason, Track, AudioPresets, createLocalAudioTrack } from "./livekit-client.esm.mjs";
import { mapTokenStatus, STATE_TEXT, audioConstraints, retryDelayMs, sha256Hex, createSession } from "./publisher-core.js";

const $ = (id) => document.getElementById(id);
const codeEl = $("code"), startBtn = $("start"), stateEl = $("state"), warnEl = $("warning");
const liveEl = $("live"), micEl = $("mic"), levelEl = $("level");

const session = createSession();
let config = { publisherTokenEndpoint: "/publisher-token", audioProcessing: "all" };
let room = null;
let track = null;
let deviceId = null;
let busy = false;
let meter = null;

const setState = (k) => { stateEl.textContent = STATE_TEXT[k] ?? k; };
const setWarning = (t) => { warnEl.textContent = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (res.ok) config = { ...config, ...(await res.json()) };
  } catch { /* defaults */ }
}

async function fetchToken() {
  const body = JSON.stringify({ code: session.getCode() });
  const res = await fetch(config.publisherTokenEndpoint, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-amz-content-sha256": await sha256Hex(crypto.subtle, body) },
    body,
  });
  const kind = mapTokenStatus(res.status);
  if (kind !== "ok") return { kind };
  const data = await res.json();
  return { kind, token: data.token, url: data.url };
}

function stopMeter() {
  if (meter) { clearInterval(meter.timer); meter.ctx.close().catch(() => {}); meter = null; }
  levelEl.value = -80;
}
function startMeter(mediaTrack) {
  stopMeter();
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    levelEl.value = Math.max(-80, 20 * Math.log10(Math.sqrt(s / buf.length) || 1e-4));
    session.tick(); // only while this timer runs; a sleeping page stops counting
  }, 200);
  meter = { ctx, timer };
}

async function listMics() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  micEl.replaceChildren();
  for (const d of devs.filter((x) => x.kind === "audioinput")) {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || "Microphone";
    if (d.deviceId === deviceId) o.selected = true;
    micEl.appendChild(o);
  }
}

async function acquire() {
  if (track) { track.stop(); track = null; }
  track = await createLocalAudioTrack(audioConstraints(config.audioProcessing, deviceId));
  const mt = track.mediaStreamTrack;
  mt.addEventListener("ended", () => setWarning("The microphone stopped. Check the device."));
  mt.addEventListener("mute", () => setWarning("The microphone is muted."));
  mt.addEventListener("unmute", () => setWarning(""));
  startMeter(mt);
  await listMics();
}

async function connect() {
  const t = await fetchToken();
  if (t.kind !== "ok") return t.kind;
  setState("asking");
  if (!track) await acquire();
  room = new Room({ adaptiveStream: false, dynacast: false });
  room.on(RoomEvent.Disconnected, onDisconnected);
  await room.connect(t.url, t.token);
  await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: false, audioPreset: AudioPresets.speech });
  session.published();
  liveEl.hidden = false;
  setState("sending");
  setWarning("");
  return "ok";
}

async function onDisconnected(reason) {
  room = null;
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
    session.duplicate();
    shutdownMedia();
    setState("takenOver");
    startBtn.disabled = false;
    return;
  }
  if (reason === DisconnectReason.CLIENT_INITIATED) return;
  await reconnectLoop();
}

async function reconnectLoop() {
  setState("reconnecting");
  for (let attempt = 0; session.canReconnect(); attempt++) {
    await sleep(retryDelayMs(attempt));
    if (!session.canReconnect()) break;
    try {
      const r = await connect();
      if (r === "ok") return;
      if (r === "wrong" || r === "closed") { session.clear(); shutdownMedia(); setState(r); startBtn.disabled = false; return; }
    } catch { /* try again within the bound */ }
  }
  session.clear();
  shutdownMedia();
  setState("waiting");
  startBtn.disabled = false;
}

function shutdownMedia() {
  stopMeter();
  if (track) { track.stop(); track = null; }
  liveEl.hidden = true;
}

async function start() {
  if (busy) return;
  const code = codeEl.value;
  codeEl.value = "";
  if (!code.trim()) return;
  busy = true;
  startBtn.disabled = true;
  setWarning("");
  session.setCode(code);
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await connect();
      if (r === "ok") return;
      if (r === "retry") { setState("retry"); await sleep(retryDelayMs(attempt)); continue; }
      session.clear();
      setState(r);
      startBtn.disabled = false;
      return;
    }
  } catch {
    session.clear();
    shutdownMedia();
    setState("error");
    startBtn.disabled = false;
  } finally {
    busy = false;
  }
}

startBtn.addEventListener("click", start);
codeEl.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
micEl.addEventListener("change", async () => {
  deviceId = micEl.value;
  if (!room) return;
  const old = track;
  try { if (old) await room.localParticipant.unpublishTrack(old, true); await acquire(); await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone, dtx: false, audioPreset: AudioPresets.speech }); } catch { setWarning("Could not switch the microphone."); }
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (track) listMics().catch(() => {}); });
window.addEventListener("beforeunload", (e) => {
  if (room) { e.preventDefault(); e.returnValue = ""; }
  session.clear();
});
await loadConfig();
setState("waiting");
