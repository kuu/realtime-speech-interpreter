// Pure builder for the TranslateText request (unit-testable without AWS).
import type { TranslateTextCommandInput } from "@aws-sdk/client-translate";

export interface TranslateParamsConfig {
  source: string;
  target: string;
  terminologyName: string;
  // FORMAL / INFORMAL set Settings.Formality; "off" sends no Settings (old behavior).
  formality: "FORMAL" | "INFORMAL" | "off";
}

export function translateParams(text: string, cfg: TranslateParamsConfig): TranslateTextCommandInput {
  return {
    Text: text,
    SourceLanguageCode: cfg.source,
    TargetLanguageCode: cfg.target,
    ...(cfg.terminologyName ? { TerminologyNames: [cfg.terminologyName] } : {}),
    ...(cfg.formality === "FORMAL" || cfg.formality === "INFORMAL"
      ? { Settings: { Formality: cfg.formality } }
      : {}),
  };
}
