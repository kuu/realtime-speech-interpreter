// Builds the StartStreamTranscription request (without AudioStream).
//   off    = single-language stream (LanguageCode + VocabularyName), exactly the old request
//   langid = multi-language identification: every result carries a LanguageCode; the
//            existing source-language vocabulary goes into VocabularyNames (the API only
//            requires that at least one vocabulary matches one of the LanguageOptions).
// Language ID is a parameter of transcribe:StartStreamTranscription; no extra IAM action.

import type { StartStreamTranscriptionCommandInput } from "@aws-sdk/client-transcribe-streaming";

export interface TranscribeSettings {
  languageCode: string;
  vocabularyName: string;
  partialResultsStability: string;
}
export interface LanguageFilterSettings {
  mode: "off" | "langid";
  options: readonly string[];
}

export function transcribeParams(
  t: TranscribeSettings,
  sampleRateHertz: number,
  lf: LanguageFilterSettings,
): Omit<StartStreamTranscriptionCommandInput, "AudioStream"> {
  if (lf.mode === "off") {
    return {
      LanguageCode: t.languageCode as any,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: sampleRateHertz,
      ...(t.vocabularyName ? { VocabularyName: t.vocabularyName } : {}),
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
    ...(t.vocabularyName ? { VocabularyNames: t.vocabularyName } : {}),
    EnablePartialResultsStabilization: true,
    PartialResultsStability: t.partialResultsStability as any,
  };
}
