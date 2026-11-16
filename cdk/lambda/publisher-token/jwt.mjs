// Minimal LiveKit access-token (HS256 JWT) minting with node:crypto (no dependencies).
// The grant is fixed here: one identity, one room, microphone publishing only, nothing else.
import { createHmac } from "node:crypto";
const b64url = (buf) => Buffer.from(buf).toString("base64url");
export const PUBLISHER_IDENTITY = "browser-publisher";
export function mintPublisherToken({ apiKey, apiSecret, room, ttlSec, nowSec }) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: PUBLISHER_IDENTITY,
    name: PUBLISHER_IDENTITY,
    nbf: nowSec,
    exp: nowSec + ttlSec,
    video: {
      room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ["microphone"],
      canPublishData: false,
      canSubscribe: false,
      canUpdateOwnMetadata: false,
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", apiSecret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}
