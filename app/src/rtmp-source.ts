// RTMP ingest source (INPUT_SOURCE=rtmps). The app is the RTMP LISTENER: Caddy (layer4, on the LiveKit
// host) terminates TLS and forwards plain RTMP through the NLB. ffmpeg `-listen 1` accepts the publisher
// and decodes the audio to raw 16-bit mono PCM on stdout, exactly like the SRT source.
//
// Stream key check. ffmpeg only LOGS a wrong stream key ("Unexpected stream ...") and a wrong app name
// ("App field don't match up ...") and then keeps decoding. So the PCM is gated: nothing is forwarded
// until stderr shows the input was opened ("Input #0") with no mismatch line before it. A mismatch kills
// ffmpeg and drops the held PCM; PCM that arrives while the gate stays closed for gateMs is treated as a
// rejection too (fail closed). The key never appears in a log line. The check depends on ffmpeg's log
// text; test/rtmp-ffmpeg-image.test.ts runs it against the ffmpeg of the app image.
import { spawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { config } from "./config.js";
import { log } from "./log.js";

export interface RtmpSource {
  chunks: Readable; // raw PCM byte stream (ffmpeg stdout, after the key gate)
  stop: () => void;
}

export const KEY_PATTERN = /^[A-Za-z0-9]{16,128}$/;
// Hold PCM at most this long while the gate is closed; then fail closed.
export const GATE_MS = 2000;
const MISMATCH = /Unexpected stream|App field don't match/;
const OPENED = /^Input #0\b/m;

// Refuse to start without a valid key: an RTMP listener with no key would accept anyone.
export function assertRtmpConfig(key: string = config.rtmp.streamKey): void {
  if (!key) throw new Error("INPUT_SOURCE=rtmps needs RTMP_STREAM_KEY (the Secrets Manager stream key); refusing to start without it");
  if (!KEY_PATTERN.test(key)) throw new Error("RTMP_STREAM_KEY must be 16-128 letters/digits; refusing to start");
}

export function buildRtmpUrl(host: string, port: number, key: string): string {
  return `rtmp://${host}:${port}/live/${key}`;
}

export function redact(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

// ffmpeg arguments. -listen 1 and -analyzeduration are input options and precede -i.
export function rtmpListenerArgs(url: string, analyzeMs: number, channels: number, sampleRate: number): string[] {
  return [
    "-hide_banner",
    // info (not warning): the "Input #0" line is the gate's open signal. Lines are logged at debug only.
    "-loglevel", "info",
    ...(analyzeMs > 0 ? ["-analyzeduration", String(Math.round(analyzeMs * 1000))] : []),
    "-listen", "1",
    "-i", url,
    "-vn",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ac", String(channels),
    "-ar", String(sampleRate),
    "pipe:1",
  ];
}

// The key gate, separated from the process so it is testable with any ordering of stdout and stderr.
export class KeyGate {
  private state: "closed" | "open" | "rejected" = "closed";
  private held: Buffer[] = [];
  private timer: NodeJS.Timeout | undefined;
  private log = "";
  private firstHeldAt: number | undefined;
  constructor(
    private readonly out: (c: Buffer) => void,
    private readonly onReject: () => void,
    private readonly gateMs: number = GATE_MS,
    private readonly onOpen: (heldMs: number) => void = () => {},
  ) {}
  get status(): "closed" | "open" | "rejected" { return this.state; }
  stderr(text: string): void {
    if (this.state === "rejected") return;
    if (MISMATCH.test(text)) return this.reject();
    if (this.state === "open") return;
    this.log = (this.log + text).slice(-4096);
    if (OPENED.test(this.log)) {
      this.state = "open";
      clearTimeout(this.timer);
      this.onOpen(this.firstHeldAt === undefined ? 0 : Date.now() - this.firstHeldAt);
      for (const b of this.held) this.out(b);
      this.held = [];
    }
  }
  stdout(chunk: Buffer): void {
    if (this.state === "rejected") return;
    if (this.state === "open") return this.out(chunk);
    this.firstHeldAt ??= Date.now();
    this.held.push(chunk);
    this.timer ??= setTimeout(() => this.reject(), this.gateMs);
  }
  reject(): void {
    if (this.state === "rejected") return;
    this.state = "rejected";
    clearTimeout(this.timer);
    this.held = [];
    this.onReject();
  }
  dispose(): void { clearTimeout(this.timer); }
}

export function startRtmpListener(): RtmpSource {
  const key = config.rtmp.streamKey;
  assertRtmpConfig(key);
  const url = buildRtmpUrl(config.rtmp.listenHost, config.rtmp.listenPort, key);
  const args = rtmpListenerArgs(url, config.rtmp.analyzeMs, config.audio.channels, config.audio.sampleRateHertz);
  log.info(`[rtmp] listening on port ${config.rtmp.listenPort} (url ${redact(url, key)}) analyzeMs=${config.rtmp.analyzeMs}`);
  const chunks = new PassThrough();
  const ff = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const gate = new KeyGate(
    (c) => chunks.write(c),
    () => {
      log.warn("[rtmp] rejected publish with a wrong key");
      if (!ff.killed) ff.kill("SIGTERM");
      chunks.end(); // ends the session; the main loop starts a new listener
    },
    GATE_MS,
    (heldMs) => log.info(`[rtmp] publish accepted (PCM held ${heldMs} ms by the key gate)`),
  );
  ff.stderr?.on("data", (d: Buffer) => {
    const text = d.toString();
    gate.stderr(text);
    const line = redact(text.trim(), key);
    // a mismatch line names the received stream, never log it
    if (line && !MISMATCH.test(line)) log.debug(`[ffmpeg] ${line}`);
  });
  if (!ff.stdout) throw new Error("ffmpeg stdout is not available");
  ff.stdout.on("data", (c: Buffer) => gate.stdout(c));
  ff.stdout.on("error", (err) => chunks.destroy(err));
  ff.on("exit", (code, signal) => {
    log.info(`[rtmp] ffmpeg exited code=${code} signal=${signal}`);
  });
  ff.stdout.on("end", () => {
    gate.dispose();
    if (gate.status !== "rejected") chunks.end();
  });
  return {
    chunks,
    stop: () => {
      gate.dispose();
      if (!ff.killed) ff.kill("SIGTERM");
    },
  };
}
