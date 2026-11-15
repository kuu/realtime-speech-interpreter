// Creates a LiveKit access token for the configured room.
// Usage:
//   npm run token -- <identity> <publish|subscribe>
// Example (listener token for the web page):
//   npm run token -- listener subscribe

import { AccessToken } from "livekit-server-sdk";
import { config } from "../config.js";

async function main(): Promise<void> {
  const identity = process.argv[2] ?? "listener";
  const role = process.argv[3] ?? "subscribe";
  const canPublish = role === "publish";

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: config.livekit.tokenTtl,
  });
  at.addGrant({
    roomJoin: true,
    room: config.livekit.roomName,
    canPublish,
    canSubscribe: true,
  });

  console.log(await at.toJwt());
}

main().catch((err) => {
  console.error("Token creation failed:", err);
  process.exit(1);
});
