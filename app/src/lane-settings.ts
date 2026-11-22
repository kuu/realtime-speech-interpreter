// Per-lane settings: everything a lane reads that used to come straight from the global config. For lane 1 of a
// default deploy every value equals today's config value, so the one-lane path does not change.
import { config, type TranslateEngineName, type TranslateFormality } from "./config.js";
import type { ChannelSpec } from "./channels.js";

type GlobalConfig = typeof config;
export interface LaneSettings {
  id: string; // channel id = target language code
  index: number; // 0 = default channel (keeps the legacy names)
  source: string; // Transcribe code
  target: string; // Translate target code
  polly: { voiceId: string; engine: string; sampleRateHertz: number };
  // Speed control follows the target language: ja = the global settings, en = off (100% only).
  speed: GlobalConfig["playback"]["speed"];
  translate: {
    sourceLanguageCode: string;
    targetLanguageCode: string;
    terminologyName: string;
    formality: TranslateFormality; // "off" for an English target (Formality is not sent)
    engine: TranslateEngineName;
  };
  livekit: { roomName: string; identity: string; trackName: string; captionTopic: string };
  captionIdPrefix: string; // "" for the default channel, "<id>:" for the others
}

const LANE1 = { identity: "publisher-app", trackName: "translation-audio", captionTopic: "captions" } as const;

export function laneSettingsFor(spec: ChannelSpec, index: number, cfg: GlobalConfig = config): LaneSettings {
  const id = spec.target;
  const first = index === 0;
  const jaTarget = spec.target === "ja";
  return {
    id,
    index,
    source: spec.source,
    target: spec.target,
    polly: { voiceId: spec.pollyVoice, engine: cfg.polly.engine, sampleRateHertz: cfg.polly.sampleRateHertz },
    speed: jaTarget ? cfg.playback.speed : { ...cfg.playback.speed, mode: "off" },
    translate: {
      sourceLanguageCode: spec.translateSource ?? spec.source.split("-")[0].toLowerCase(),
      targetLanguageCode: spec.target,
      terminologyName: spec.translateTerminology,
      formality: jaTarget ? cfg.translate.formality : "off",
      engine: spec.translateEngine ?? cfg.translate.engine,
    },
    livekit: {
      roomName: cfg.livekit.roomName,
      identity: first ? LANE1.identity : `${LANE1.identity}-${id}`,
      trackName: first ? LANE1.trackName : `${LANE1.trackName}-${id}`,
      captionTopic: first ? LANE1.captionTopic : `${LANE1.captionTopic}-${id}`,
    },
    captionIdPrefix: first ? "" : `${id}:`,
  };
}
