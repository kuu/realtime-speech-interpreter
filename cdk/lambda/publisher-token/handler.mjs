// Publisher token endpoint (behind CloudFront at /publisher-token). Mints a token that lets one browser
// publish a microphone track into the ingest room, only if it knows the event code and the event is open.
// The code, the end time and the LiveKit credentials are read on every call (no cache), so a rotation or a
// new end time takes effect on the next request. Nothing about the code is ever logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { mintPublisherToken } from "./jwt.mjs";

const headers = { "content-type": "application/json", "cache-control": "no-store" };
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const INVALID = () => reply(401, { error: "invalid" });
const CLOSED = () => reply(403, { error: "not available" });
const INTERNAL = () => reply(500, { error: "internal error" });
const NOT_AFTER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_BODY_BYTES = 256;
const MIN_CODE_CHARS = 10;

export const normalizeCode = (s) => String(s).toUpperCase().replace(/[\s-]/g, "");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();

export function parseNotAfter(value) {
  if (typeof value !== "string" || !NOT_AFTER_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) + "Z" !== value) return null;
  return ms;
}

export function createHandler({
  readCode,
  readNotAfter,
  readLiveKit,
  room,
  ttlSec,
  livekitUrl,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  compare = timingSafeEqual,
  log = (line) => console.log(line),
}) {
  const attempt = (outcome, event) => {
    const xff = event?.headers?.["x-forwarded-for"];
    const addr = typeof xff === "string" ? xff.split(",")[0].trim() : "unknown";
    log(`publisher-token outcome=${outcome} addr=${addr} at=${new Date(now()).toISOString()}`);
  };
  return async function handler(event) {
    const method = event?.requestContext?.http?.method ?? "";
    if (method !== "POST") return reply(405, { error: "method not allowed" });
    try {
      const notAfter = parseNotAfter(await readNotAfter());
      if (notAfter === null) { attempt("closed", event); return INTERNAL(); }
      if (now() >= notAfter) { attempt("closed", event); return CLOSED(); }

      const type = String(event?.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      let raw = typeof event?.body === "string" ? event.body : "";
      if (event?.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
      let submitted = null;
      if (type === "application/json" && Buffer.byteLength(raw, "utf8") <= MAX_BODY_BYTES) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.code === "string") submitted = parsed.code;
        } catch { /* malformed */ }
      }
      if (submitted === null) { attempt("malformed", event); return INVALID(); }

      const stored = normalizeCode(await readCode());
      if (stored.length < MIN_CODE_CHARS) { attempt("closed", event); return INTERNAL(); }
      const ok = compare(sha256(normalizeCode(submitted)), sha256(stored));
      if (!ok) {
        attempt("bad_code", event);
        await sleep(1000);
        return INVALID();
      }
      const { apiKey, apiSecret } = await readLiveKit();
      if (!apiKey || !apiSecret) throw new Error("LiveKit secret missing apiKey/apiSecret");
      const nowSec = Math.floor(now() / 1000);
      const token = mintPublisherToken({ apiKey, apiSecret, room, ttlSec, nowSec });
      attempt("ok", event);
      return reply(200, { token, url: livekitUrl, expiresAt: new Date((nowSec + ttlSec) * 1000).toISOString() });
    } catch {
      // Never log the error object: it could carry request data. The outcome line is enough.
      log("publisher-token outcome=error");
      return INTERNAL();
    }
  };
}
