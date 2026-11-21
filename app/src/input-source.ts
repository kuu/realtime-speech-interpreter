// Which audio input runs. INPUT_FILE (the test mode) wins, as before; otherwise exactly one live source:
// the browser microphone ingest, the RTMP listener (RTMPS front) or the SRT listener. Never two.
export type InputKind = "file" | "browser" | "rtmps" | "srt";
export function selectSource(opts: { inputFile?: string; source: "srt" | "browser" | "rtmps" }): InputKind {
  if (opts.inputFile) return "file";
  if (opts.source === "browser") return "browser";
  if (opts.source === "rtmps") return "rtmps";
  return "srt";
}
