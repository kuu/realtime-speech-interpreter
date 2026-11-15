// Unit tests for context-aware corrections (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCorrections } from "./corrections.js";

const fix = (s: string) => applyCorrections(s).text;

test("positive cases from the evidence", () => {
  assert.equal(fix("uh, and because it supports both ABC and HEBC."), "uh, and because it supports both AVC and HEVC.");
  assert.equal(fix("At lunch, we support a set of six"), "At launch, we support a set of six");
  assert.equal(fix("Xixi wrist RTP"), "Zixi RIST RTP");
  assert.equal(fix("ZXixi is supported"), "Zixi is supported");
  assert.equal(fix("We encode with ABC and HEVC"), "We encode with AVC and HEVC");
  assert.equal(fix("Lunch of the new MediaLive feature"), "Launch of the new MediaLive feature");
});

test("applied lists wrong -> right", () => {
  assert.deepEqual(applyCorrections("because it supports both ABC and HEBC").applied, ["HEBC -> HEVC", "ABC -> AVC"]);
});

test("must-not-replace cases stay unchanged", () => {
  for (const s of [
    "ABC News reported",
    "ABC, NBC and CBS",
    "easy as ABC",
    "we ship ABC and XYZ",
    "a wrist watch",
    "lunch break at 12",
    "we serve lunch before the session",
    "Lunch is served in the foyer",
    "the launch of the feature",
    "AVC and HEVC",
    "HEVC",
    "I hurt my wrist",
    "SRT and wrist band",
    "ABC News supports both codecs",
    "ABC supports both formats.",
    "We break for lunch at noon.",
    "At lunch we have a session in the foyer.",
    "Lunch is available on the second floor.",
    "Lunch will be provided at the channel partner area.",
    "We have a lunch service in the foyer.",
    "Please enjoy lunch, then join the preview session.",
  ]) {
    assert.equal(fix(s), s, s);
  }
});

test("idempotent", () => {
  for (const s of ["uh, and because it supports both ABC and HEBC.", "At lunch, we support a set of six", "Xixi wrist RTP", "fertilization"]) {
    const once = fix(s);
    assert.equal(fix(once), once);
  }
});

test("fertilization rules and empty string", () => {
  assert.equal(fix("the fertilization of fertilized fertilize"), "the verticalization of verticalized verticalize");
  assert.deepEqual(applyCorrections(""), { text: "", applied: [] });
});
