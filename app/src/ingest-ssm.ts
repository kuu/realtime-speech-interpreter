import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { config } from "./config.js";
/** Reads the event end time parameter. Returns undefined when the parameter does not exist (= closed). */
export function ssmNotAfterReader(name: string): () => Promise<string | undefined> {
  const client = new SSMClient({ region: config.region });
  return async () => {
    try {
      const out = await client.send(new GetParameterCommand({ Name: name }));
      return out.Parameter?.Value;
    } catch (err) {
      if ((err as { name?: string }).name === "ParameterNotFound") return undefined;
      throw err;
    }
  };
}
