// Pacing of the local INPUT_FILE feed (test mode). Pure, so it is unit-testable.
//   sleep    = the old behavior: sleep(frameMs) after every frame. Timer overshoot adds up
//              (~1 %, +2.5 s after 4 min), so local commitLag/e2e grow over the clip.
//   absolute = frame k is due at start + (bytes sent so far) / bytesPerMs; overshoot of one
//              sleep is absorbed by the next, so the feed never drifts from real time.
export type InputPacing = "absolute" | "sleep";

// How long to wait after pushing a frame, given `bytesSent` bytes pushed so far (incl. it).
export function pacingDelayMs(
  mode: InputPacing,
  startMs: number,
  bytesSent: number,
  bytesPerMs: number,
  frameMs: number,
  now: number,
): number {
  if (mode === "sleep") return frameMs;
  return Math.max(0, startMs + bytesSent / bytesPerMs - now);
}
