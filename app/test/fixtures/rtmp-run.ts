// Test helper (run in a child process so config reads its own env): starts the RTMP source, counts the
// PCM bytes it forwards for RUN_MS and prints "BYTES <n>" and "ENDED <0|1>". Loopback only.
import { startRtmpListener } from "../../src/rtmp-source.js";
const src = startRtmpListener();
let bytes = 0;
let ended = 0;
src.chunks.on("data", (c: Buffer) => (bytes += c.length));
src.chunks.on("end", () => (ended = 1));
setTimeout(() => {
  src.stop();
  console.log(`BYTES ${bytes}`);
  console.log(`ENDED ${ended}`);
  process.exit(0);
}, Number(process.env.RUN_MS ?? 5000));
