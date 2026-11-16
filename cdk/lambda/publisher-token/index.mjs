import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { createHandler } from "./handler.mjs";

const sm = new SecretsManagerClient({});
const ssm = new SSMClient({});
const secret = async (id) => JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: id }))).SecretString);

export const handler = createHandler({
  readCode: async () => (await secret(process.env.CODE_SECRET_ARN)).code,
  readNotAfter: async () => {
    try {
      return (await ssm.send(new GetParameterCommand({ Name: process.env.NOT_AFTER_PARAM }))).Parameter?.Value;
    } catch {
      return undefined; // missing or unreadable parameter means closed
    }
  },
  readLiveKit: () => secret(process.env.LIVEKIT_SECRET_ARN),
  room: process.env.INGEST_ROOM,
  ttlSec: Number(process.env.TOKEN_TTL_SEC),
  livekitUrl: process.env.LIVEKIT_URL,
});
