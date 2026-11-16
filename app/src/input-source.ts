// Which audio input runs. INPUT_FILE (the test mode) wins, as before; otherwise exactly one live source:
// the SRT listener or the browser microphone ingest. Never both.
export type InputKind = "file" | "browser" | "srt";
export function selectSource(opts: { inputFile?: string; source: "srt" | "browser" }): InputKind {
  if (opts.inputFile) return "file";
  return opts.source === "browser" ? "browser" : "srt";
}
