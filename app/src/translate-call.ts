// Amazon Translate call and the shared per-call timeout helper, moved unchanged from chunk-player.ts.
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import { config } from "./config.js";
import { translateParams } from "./translate-params.js";

export const translateClient = new TranslateClient({ region: config.region, maxAttempts: 3 });

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.playback.callTimeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function translateText(text: string): Promise<string> {
  const res = await withTimeout((abortSignal) =>
    translateClient.send(
      new TranslateTextCommand(
        translateParams(text, {
          source: config.translate.sourceLanguageCode,
          target: config.translate.targetLanguageCode,
          terminologyName: config.translate.terminologyName,
          formality: config.translate.formality,
        }),
      ),
      { abortSignal },
    ),
  );
  return res.TranslatedText ?? "";
}
