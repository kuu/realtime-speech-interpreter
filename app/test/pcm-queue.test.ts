import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmQueue } from "../src/pcm-queue.js";

test("pendingBytes counts queued whole frames; trimTo drops the oldest and returns the dropped bytes", async () => {
  const q = new PcmQueue(4);
  q.push(Buffer.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4]));
  assert.equal(q.pendingBytes, 12);
  assert.equal(q.trimTo(8), 4);
  assert.equal(q.pendingBytes, 8);
  assert.equal(q.trimTo(100), 0);
  q.end();
  const out: number[] = [];
  for await (const f of q.frames$()) out.push(f[0]);
  assert.deepEqual(out, [2, 3, 4]);
});
