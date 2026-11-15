// Unit tests for Polly speed control (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeedController, buildSsml, escapeXml, spokenChars, stepsRate, type SpeedConfig } from "../src/speed-control.js";
import { parseSpeedLevels, parseSpeedThresholds, parseSpeedupSteps, type SpeedupStep } from "../src/config.js";

const BASE: SpeedConfig = {
  mode: "levels",
  levels: [100, 110, 120, 130, 145],
  thresholdsMs: [3000, 4500, 6000, 7500],
  hysteresisMs: 1000,
  holdMs: 0,
  urgentMs: 10000,
  lookahead: 1,
  msPerChar: 150,
  resetGapMs: 3000,
  steps: parseSpeedupSteps("3000:115,5000:130,7000:150") as SpeedupStep[],
};
const ctl = (over: Partial<SpeedConfig> = {}) => new SpeedController({ ...BASE, ...over });
const sig = (backlogMs: number, idleGapMs = 0) => ({ backlogMs, estJaMs: 0, enSpanMs: 0, idleGapMs });

// Verbatim copy of the old chunk-player rateFor(), with the steps passed in.
function oldRateFor(steps: readonly SpeedupStep[], backlogMs: number): number {
  let rate = 100;
  for (const step of steps) {
    if (backlogMs >= step.backlogMs) rate = step.rate;
  }
  return rate;
}

test("(a) level selection from a static signal (fresh controller, hold 0, no urgent)", () => {
  const cases: [number, number][] = [
    [0, 1],
    [2999, 1],
    [3000, 2],
    [4499, 2],
    [4500, 3],
    [6000, 4],
    [7499, 4],
    [7500, 5],
    [9999, 5],
  ];
  for (const [b, want] of cases) {
    const c = ctl({ urgentMs: 0 });
    let d = c.decide(sig(b));
    for (let i = 0; i < 6; i++) d = c.decide(sig(b)); // let the slew limit reach the target
    assert.equal(d.level, want, `backlog ${b}`);
    assert.equal(d.targetLevel, want, `backlog ${b}`);
    assert.equal(d.rate, BASE.levels[want - 1]);
  }
  // The first decision is at most one step above L1.
  assert.equal(ctl({ urgentMs: 0 }).decide(sig(9000)).level, 2);
});

test("(b) hysteresis: a signal oscillating 2900<->3100 around T=3000 changes level once", () => {
  const c = ctl();
  const levels: number[] = [];
  const whys: string[] = [];
  for (let i = 0; i < 20; i++) {
    const d = c.decide(sig(i % 2 === 0 ? 3100 : 2900));
    levels.push(d.level);
    whys.push(d.why);
  }
  let changes = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i] !== levels[i - 1]) changes++;
  assert.equal(levels[0], 2);
  assert.equal(changes, 0); // stays at L2 after the single up-change
  assert.ok(whys.includes("hyst"));
  // Below the band it does come down.
  assert.equal(c.decide(sig(1999)).level, 1);
});

test("(c) slew: a jump 0 -> 9000 (below urgent) moves one level per chunk", () => {
  const c = ctl();
  assert.equal(c.decide(sig(0)).level, 1);
  const seq = [1, 2, 3, 4].map(() => c.decide(sig(9000)));
  assert.deepEqual(
    seq.map((d) => d.level),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    seq.map((d) => d.why),
    ["slew", "slew", "slew", "target"],
  );
  assert.ok(seq.every((d) => d.targetLevel === 5));
  // Down also one level per chunk (no idle gap).
  assert.deepEqual(
    [1, 2, 3, 4].map(() => c.decide(sig(0)).level),
    [4, 3, 2, 1],
  );
});

test("(d) urgent: a 12000 signal jumps L1 -> L5 at once", () => {
  const c = ctl({ holdMs: 4000 });
  const d1 = c.decide(sig(0));
  c.recordAudio(500);
  assert.equal(d1.level, 1);
  const d = c.decide(sig(12000)); // also bypasses the hold
  assert.equal(d.level, 5);
  assert.equal(d.why, "urgent");
  // urgentMs=0 disables the bypass.
  const c2 = ctl({ urgentMs: 0 });
  assert.equal(c2.decide(sig(12000)).level, 2);
});

test("(e) hold: with hold 4000, 1-s chunks need 4 recorded seconds before the next change", () => {
  const c = ctl({ holdMs: 4000 });
  const first = c.decide(sig(9000)); // first chunk: hold already satisfied
  assert.equal(first.level, 2);
  c.recordAudio(1000);
  const levels: number[] = [];
  const whys: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = c.decide(sig(9000));
    levels.push(d.level);
    whys.push(d.why);
    c.recordAudio(1000);
  }
  // 1 s recorded after the change; 3 more 1-s chunks held, then up (4 s at L2).
  assert.deepEqual(levels, [2, 2, 2, 3, 3, 3, 3, 4]);
  assert.deepEqual(whys.slice(0, 3), ["hold", "hold", "hold"]);
});

test("(f) reset: an idle gap of 5000 drops L5 -> L1 in one step", () => {
  const c = ctl({ holdMs: 4000 });
  c.decide(sig(12000)); // urgent to L5
  assert.equal(c.decide(sig(12000)).level, 5);
  const d = c.decide(sig(0, 5000));
  assert.equal(d.level, 1);
  assert.equal(d.why, "reset");
  // resetGapMs=0 disables it; without idle gap only one step (hold permitting).
  const c2 = ctl({ resetGapMs: 0 });
  c2.decide(sig(12000));
  assert.equal(c2.decide(sig(0, 5000)).level, 4);
});

test("(g) look-ahead raises the signal for long Japanese and never lowers it", () => {
  const c = ctl();
  const up = c.decide({ backlogMs: 2000, estJaMs: 4000, enSpanMs: 2500, idleGapMs: 0 });
  assert.equal(up.signalMs, 3500);
  assert.equal(up.level, 2);
  const c2 = ctl();
  const same = c2.decide({ backlogMs: 2000, estJaMs: 1000, enSpanMs: 4000, idleGapMs: 0 });
  assert.equal(same.signalMs, 2000);
  assert.equal(same.level, 1);
  const c3 = ctl({ lookahead: 0 });
  assert.equal(c3.decide({ backlogMs: 2000, estJaMs: 9000, enSpanMs: 0, idleGapMs: 0 }).signalMs, 2000);
});

test("(h) steps mode gives exactly the old rateFor rates", () => {
  for (const raw of ["3000:115,5000:130,7000:150", "1000:120,2000:200"]) {
    const steps = parseSpeedupSteps(raw) as SpeedupStep[];
    const c = ctl({ mode: "steps", steps });
    for (let b = -1000; b <= 20000; b += 50) {
      const d = c.decide(sig(b));
      assert.equal(d.rate, oldRateFor(steps, b), `${raw} backlog ${b}`);
      assert.equal(d.why, "steps");
      assert.equal(stepsRate(steps, b).rate, oldRateFor(steps, b));
    }
  }
  assert.equal(stepsRate(BASE.steps, 0).level, 1);
  assert.equal(stepsRate(BASE.steps, 5000).level, 3);
  assert.equal(stepsRate(BASE.steps, 7000).level, 4);
  const off = ctl({ mode: "steps", steps: parseSpeedupSteps("off") as SpeedupStep[] });
  assert.equal(off.decide(sig(20000)).rate, 100);
});

test("(i) off mode always speaks at 100%, level 1", () => {
  const c = ctl({ mode: "off" });
  for (const b of [0, 5000, 20000]) {
    const d = c.decide(sig(b));
    assert.equal(d.rate, 100);
    assert.equal(d.level, 1);
    assert.equal(d.why, "off");
  }
});

test("(j) buildSsml escapes text, emits one prosody tag and validates the rate", () => {
  assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  const s = buildSsml(`A&B <x> "q" 'p'`, 120) as string;
  assert.equal(s, `<speak><prosody rate="120%">A&amp;B &lt;x&gt; &quot;q&quot; &apos;p&apos;</prosody></speak>`);
  assert.equal(s.split('<prosody rate="120%">').length - 1, 1);
  assert.equal(s.split("<prosody").length - 1, 1);
  assert.equal(buildSsml("こんにちは", 100), null);
  assert.ok(buildSsml("x", 200));
  assert.throws(() => buildSsml("x", 99));
  assert.throws(() => buildSsml("x", 201));
  assert.throws(() => buildSsml("x", 120.5));
});

test("(k) spokenChars ignores whitespace, punctuation and symbols", () => {
  // こ れ は テ ス ト で す H L S = 11
  assert.equal(spokenChars("これは、テストです。HLS"), 11);
  assert.equal(spokenChars(" 「AWS」・100%！ "), 6);
  assert.equal(spokenChars(""), 0);
});

test("parseSpeedLevels / parseSpeedThresholds", () => {
  assert.deepEqual(parseSpeedLevels("100,110,120,130,145"), [100, 110, 120, 130, 145]);
  assert.deepEqual(parseSpeedLevels(" 100 , 150 "), [100, 150]);
  assert.equal(parseSpeedLevels("100,90"), null); // out of range + unsorted
  assert.equal(parseSpeedLevels("110,100"), null); // unsorted
  assert.equal(parseSpeedLevels("100,100"), null); // not strictly ascending
  assert.equal(parseSpeedLevels("100,201"), null); // out of range
  assert.equal(parseSpeedLevels("100,110.5"), null); // non-integer
  assert.equal(parseSpeedLevels("100"), null); // < 2 levels
  assert.equal(parseSpeedLevels("100,101,102,103,104,105,106,107,108,109,110"), null); // > 10
  assert.equal(parseSpeedLevels(""), null);
  assert.deepEqual(parseSpeedThresholds("3000,4500,6000,7500", 5), [3000, 4500, 6000, 7500]);
  assert.equal(parseSpeedThresholds("3000,4500,6000", 5), null); // count mismatch
  assert.equal(parseSpeedThresholds("4500,3000,6000,7500", 5), null); // unsorted
  assert.equal(parseSpeedThresholds("3000,4500,6000,70000", 5), null); // out of range
  assert.equal(parseSpeedThresholds("3000,4500.5,6000,7500", 5), null); // non-integer
  assert.equal(parseSpeedThresholds("-1,4500,6000,7500", 5), null); // negative
});
