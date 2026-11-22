// Neural en-US Polly voices of Region ap-northeast-1, from `aws polly describe-voices --region ap-northeast-1
// --engine neural --language-code en-US` (read-only), checked 2026-11-22. Joanna is the default voice of an English
// lane. `doctor` repeats the check against the deployed Region; this static list only catches an obviously wrong
// name early. A voice that is not listed is not rejected by the app (Polly may have added it): it is passed through
// and doctor reports it.
export const NEURAL_EN_US_VOICES: readonly string[] = [
  "Danielle", "Gregory", "Joanna", "Ruth", "Kevin", "Salli", "Matthew", "Kimberly", "Kendra", "Justin", "Joey", "Ivy", "Stephen",
];
export const DEFAULT_ENGLISH_VOICE = "Joanna";
export function isKnownNeuralEnUs(voice: string): boolean {
  return NEURAL_EN_US_VOICES.includes(voice);
}
// Voices known to have no neural engine in the Region would be rejected here; none are listed today, so the check is
// "known neural voice" or "unknown" (pass through to doctor).
export function englishVoiceCheck(voice: string, engine: string): { ok: boolean; known: boolean; note: string } {
  if (engine !== "neural") return { ok: true, known: false, note: `engine ${engine}: not checked against the neural list` };
  return isKnownNeuralEnUs(voice)
    ? { ok: true, known: true, note: "known neural en-US voice" }
    : { ok: true, known: false, note: `voice ${voice} is not in the static neural en-US list; doctor checks it against Polly` };
}
