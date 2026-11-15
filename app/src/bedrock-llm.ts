// The only file that imports the Bedrock SDK. One Converse call with a hard abort signal.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { LlmUsage } from "./llm-stats.js";
import type { LlmRequest } from "./llm-prompt.js";

export interface ConverseResult {
  text: string;
  stopReason: string;
  usage: LlmUsage;
}

export interface LlmClient {
  converse(req: LlmRequest, signal: AbortSignal): Promise<ConverseResult>;
}

// maxAttempts 1: no hidden SDK retry delay; the engine decides what a failure means.
export function createBedrockLlm(region: string): LlmClient {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  return {
    async converse(req, signal) {
      const res = await client.send(new ConverseCommand(req as any), { abortSignal: signal });
      const text = (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
      return {
        text,
        stopReason: res.stopReason ?? "",
        usage: {
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
          cacheReadInputTokens: res.usage?.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: res.usage?.cacheWriteInputTokens ?? 0,
        },
      };
    },
  };
}
