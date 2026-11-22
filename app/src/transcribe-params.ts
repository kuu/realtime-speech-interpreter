// Builds the StartStreamTranscription request (without AudioStream).
//   off    = single-language stream (LanguageCode + VocabularyName), exactly the old request
//   langid = multi-language identification: every result carries a LanguageCode; the
//            existing source-language vocabulary goes into VocabularyNames (the API only
//            requires that at least one vocabulary matches one of the LanguageOptions).
// Language ID is a parameter of transcribe:StartStreamTranscription; no extra IAM action.

import type { StartStreamTranscriptionCommandInput } from "@aws-sdk/client-transcribe-streaming";

export interface TranscribeSettings {
  languageCode: string;
  // One name (a one-lane deploy) or one per lane; empty names are skipped. Language identification takes the
  // comma list in VocabularyNames (one vocabulary per language).
  vocabularyName: string | readonly string[];
  partialResultsStability: string;
}
export interface LanguageFilterSettings {
  mode: "off" | "langid";
  options: readonly string[];
}

function vocabularyList(v: string | readonly string[]): string {
  const names = typeof v === "string" ? [v] : v;
  return names.map((n) => n.trim()).filter(Boolean).join(",");
}

export function transcribeParams(
  t: TranscribeSettings,
  sampleRateHertz: number,
  lf: LanguageFilterSettings,
): Omit<StartStreamTranscriptionCommandInput, "AudioStream"> {
  const vocab = vocabularyList(t.vocabularyName);
  if (lf.mode === "off") {
    return {
      LanguageCode: t.languageCode as any,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: sampleRateHertz,
      ...(vocab ? { VocabularyName: vocab.split(",")[0] } : {}),
      EnablePartialResultsStabilization: true,
      PartialResultsStability: t.partialResultsStability as any,
    };
  }
  return {
    MediaEncoding: "pcm",
    MediaSampleRateHertz: sampleRateHertz,
    IdentifyMultipleLanguages: true,
    LanguageOptions: lf.options.join(","),
    PreferredLanguage: t.languageCode as any,
    ...(vocab ? { VocabularyNames: vocab } : {}),
    EnablePartialResultsStabilization: true,
    PartialResultsStability: t.partialResultsStability as any,
  };
}
