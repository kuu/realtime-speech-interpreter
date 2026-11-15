// Minimal LiveKit access-token (HS256 JWT) minting with node:crypto (no dependencies).
// The grant is fixed here: listeners may join and subscribe in one room, nothing else.
import { createHmac } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function mintListenerToken({ apiKey, apiSecret, room, ttlSec, identity, nowSec }) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: identity,
    name: "listener",
    nbf: nowSec,
    exp: nowSec + ttlSec,
    jti: identity,
    video: {
      room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    },
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", apiSecret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}
