// Listener token endpoint (behind CloudFront at /token). Anonymous by design: attendees
// open the page on their phones. It only ever issues subscribe-only LiveKit tokens for
// the configured room; no request input influences the grant.
import { randomUUID } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { mintListenerToken } from "./jwt.mjs";

const sm = new SecretsManagerClient({});
let cached = null;

async function getCredentials() {
  if (cached) return cached;
  const out = await sm.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }));
  const { apiKey, apiSecret } = JSON.parse(out.SecretString);
  if (!apiKey || !apiSecret) throw new Error("LiveKit secret missing apiKey/apiSecret");
  cached = { apiKey, apiSecret };
  return cached;
}

const headers = { "content-type": "application/json", "cache-control": "no-store" };

export async function handler(event) {
  const method = event?.requestContext?.http?.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "method not allowed" }) };
  }
  try {
    const { apiKey, apiSecret } = await getCredentials();
    const token = mintListenerToken({
      apiKey,
      apiSecret,
      room: process.env.ROOM_NAME,
      ttlSec: Number(process.env.TOKEN_TTL_SEC),
      identity: `listener-${randomUUID()}`,
      nowSec: Math.floor(Date.now() / 1000),
    });
    return { statusCode: 200, headers, body: JSON.stringify({ token }) };
  } catch (err) {
    console.error("token error", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "internal error" }) };
  }
}
