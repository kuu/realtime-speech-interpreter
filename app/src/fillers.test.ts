// Unit tests for filler removal (node:test). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterEnglish, filterJapanese, hasWords } from "./fillers.js";

const WORDS = ["um", "uh", "er", "ah", "hmm", "mm", "erm", "uh-huh"];
const PHRASES = ["you know", "I mean", "well", "like", "sort of", "kind of", "you see", "okay so", "so yeah"];
const JA = ["ええと", "えーと", "えっと", "えー", "あの", "あのー", "まあ", "ご存知のとおり", "ご存知のように", "ご存じのとおり", "ご存じのように", "ほら", "つまり、"];

const en = (s: string) => filterEnglish(s, WORDS, PHRASES);
const ja = (s: string) => filterJapanese(s, JA);

test("filler words are always removed with their comma", () => {
  assert.deepEqual(en("So, um, if you want, uh, this."), { text: "So, if you want, this.", removed: ["um", "uh"] });
  assert.equal(en("Um I think uh-huh it works").text, "I think it works");
  assert.equal(en("um").text, "");
});

test("filler words are whole words only", () => {
  assert.equal(en("the umbrella is huge, ahead of time").text, "the umbrella is huge, ahead of time");
  assert.equal(en("Hmm.").text, ".");
  assert.equal(hasWords(en("Hmm.").text), false);
});

test("discourse-marker phrases at the start are removed", () => {
  assert.deepEqual(en("You know, the service scales."), { text: "the service scales.", removed: ["you know"] });
  assert.equal(en("Well, I mean, it works.").text, "it works.");
  assert.equal(en("Okay so, let's start.").text, "let's start.");
  assert.equal(en("It ships today. Well, mostly.").text, "It ships today. mostly.");
  assert.equal(en("you know").text, "");
});

test("phrases set off by commas are removed", () => {
  assert.deepEqual(en("It is, you know, really fast."), { text: "It is, really fast.", removed: ["you know"] });
  assert.equal(en("It is really fast, you know.").text, "It is really fast.");
  assert.equal(en("We built it, like, last year, sort of, quickly").text, "We built it, last year, quickly");
});

test("literal uses survive", () => {
  for (const s of [
    "do you know the answer?",
    "I know you know this",
    "it works well",
    "I'd like to show you",
    "this kind of feature is new",
    "Well-known services",
    "Like I said, it scales.",
    "You know the drill.",
    "you see the dashboard here",
    "I mean it.",
  ]) {
    assert.equal(en(s).text, s, s);
  }
});

test("punctuation and spacing are cleaned up", () => {
  assert.equal(en("um, , you know, hello").text, "hello");
  assert.equal(en("hello, um.").text, "hello.");
});

test("Japanese fillers are stripped at the start or after 。/、", () => {
  assert.deepEqual(ja("ええと、このサービスは速いです。"), { text: "このサービスは速いです。", removed: ["ええと"] });
  assert.equal(ja("ご存知のとおり、AWSは大きいです。").text, "AWSは大きいです。");
  assert.equal(ja("これは速い。まあ、たぶん。").text, "これは速い。たぶん。");
  assert.equal(ja("これは、あのー、速いです。").text, "これは、速いです。");
  assert.equal(ja("つまり、これは新しい。").text, "これは新しい。");
  assert.equal(ja("ええと。").text, "");
});

test("Japanese literal uses survive", () => {
  for (const s of [
    "あのサービスは新しいです。", // demonstrative "that"
    "まあまあです。",
    "ご存知のとおりAWSは大きい。", // no delimiter after → kept
    "これは、つまり、新しい。", // つまり、 only at sentence start
    "ほらふき",
    "えーと言いました", // not followed by a delimiter
  ]) {
    assert.equal(ja(s).text, s, s);
  }
});
