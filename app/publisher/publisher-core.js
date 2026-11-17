// Pure logic of the publisher page (no DOM, no network). Loaded by publisher.js and by the tests.

// Time after the last successful publish in which the page may reconnect by itself (design: stale pages must not
// take the stage back from the newest speaker).
export const RECONNECT_BOUND_MS = 60000;

/** Maps the token endpoint status to what the page does. Never reveals more than the server did. */
export function mapTokenStatus(status) {
  if (status === 200) return "ok";
  if (status === 401) return "wrong";
  if (status === 403) return "closed";
  if (status === 429 || status >= 500) return "retry";
  return "error";
}

export const STATE_TEXT = {
  waiting: "Waiting for the code.",
  asking: "Asking for the microphone. Press Allow.",
  sending: "Sending",
  reconnecting: "Reconnecting",
  takenOver: "Another device took over.",
  closed: "Closed: the event is over or not open yet.",
  wrong: "Wrong code. Check it and try again.",
  retry: "The server is busy. Trying again.",
  error: "Something went wrong. Try again.",
};

/** getUserMedia audio constraints for browserAudioProcessing = all | echo | none (provisional values). */
export function audioConstraints(mode, deviceId) {
  const all = mode === "all";
  const c = {
    channelCount: 1,
    echoCancellation: mode === "all" || mode === "echo",
    noiseSuppression: all,
    autoGainControl: all,
  };
  if (deviceId) c.deviceId = { exact: deviceId };
  return c;
}

/** Retry delay in ms with jitter: 1 s doubling to 30 s, plus up to 50% random. */
export function retryDelayMs(attempt, random = Math.random) {
  const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + 0.5 * random()));
}

/** Code to show in groups of four, for display only (the page never echoes the typed code). */
export function formatCode(s) {
  const t = String(s).toUpperCase().replace(/[\s-]/g, "");
  return t.replace(/(.{4})(?=.)/g, "$1-");
}

/** SHA-256 hex of a string through a WebCrypto-compatible object (x-amz-content-sha256 for the POST). */
export async function sha256Hex(subtle, text) {
  const d = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Holds the code in memory only. The code is kept so a speaker who is not looking at the page reconnects after a
 * network drop, but only within RECONNECT_BOUND_MS of the last successful publish, and never after a takeover.
 */
export function createSession(now = () => Date.now(), boundMs = RECONNECT_BOUND_MS) {
  let code = null;
  let lastPublishAt = null;
  let tookOver = false;
  return {
    setCode(c) { code = c; tookOver = false; },
    getCode() { return code; },
    published() { lastPublishAt = now(); },
    /** Call regularly while connected, so the bound counts from the last time audio was being sent. */
    tick() { if (lastPublishAt !== null) lastPublishAt = now(); },
    canReconnect() {
      return code !== null && !tookOver && lastPublishAt !== null && now() - lastPublishAt <= boundMs;
    },
    duplicate() { tookOver = true; code = null; },
    clear() { code = null; lastPublishAt = null; },
    hasCode() { return code !== null; },
  };
}
