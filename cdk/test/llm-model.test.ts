import { test } from "node:test";
import * as assert from "node:assert/strict";
import { GEO_PROFILES, defaultLlmModelId, destinationRegions, parseProfile, supportedRegions } from "../lib/llm-model";

const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";

test("default profile prefix follows the Region", () => {
  assert.equal(defaultLlmModelId("ap-northeast-1"), `jp.${HAIKU}`);
  assert.equal(defaultLlmModelId("ap-northeast-3"), `jp.${HAIKU}`);
  assert.equal(defaultLlmModelId("us-east-1"), `us.${HAIKU}`);
  assert.equal(defaultLlmModelId("ca-central-1"), `us.${HAIKU}`);
  assert.equal(defaultLlmModelId("eu-west-3"), `eu.${HAIKU}`);
  assert.equal(defaultLlmModelId("ap-southeast-2"), `au.${HAIKU}`);
  assert.equal(defaultLlmModelId("ap-south-1"), `in.${HAIKU}`);
});
test("Regions without a geo profile give undefined (Seoul has only the global profile)", () => {
  for (const r of ["ap-northeast-2", "ap-southeast-1", "sa-east-1", "us-gov-west-1", ""]) assert.equal(defaultLlmModelId(r), undefined, r);
});
test("parseProfile accepts geo prefixes only; global. and apac. are rejected", () => {
  assert.deepEqual(parseProfile(`jp.${HAIKU}`), { prefix: "jp", foundationModelId: HAIKU });
  assert.equal(parseProfile(`global.${HAIKU}`), undefined);
  assert.equal(parseProfile(`apac.${HAIKU}`), undefined);
  assert.equal(parseProfile(HAIKU), undefined);
  assert.equal(parseProfile("jp."), undefined);
});
test("destination Regions match the model card table", () => {
  assert.deepEqual(destinationRegions("jp", "ap-northeast-1"), ["ap-northeast-1", "ap-northeast-3"]);
  assert.deepEqual(destinationRegions("us", "us-east-1"), ["us-east-1", "us-east-2", "us-west-2"]);
  assert.deepEqual(destinationRegions("us", "us-west-1"), ["us-east-1", "us-east-2", "us-west-1", "us-west-2"]);
  assert.deepEqual(destinationRegions("us", "ca-central-1"), ["ca-central-1", "us-east-1", "us-east-2", "us-west-2"]);
  assert.deepEqual(destinationRegions("eu", "eu-west-3"), ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-3"]);
  assert.deepEqual(destinationRegions("eu", "eu-west-2"), ["eu-central-1", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-2", "eu-west-3"]);
  assert.deepEqual(destinationRegions("au", "ap-southeast-6"), ["ap-southeast-2", "ap-southeast-4", "ap-southeast-6"]);
  assert.deepEqual(destinationRegions("in", "ap-south-2"), ["ap-south-1", "ap-south-2"]);
  assert.equal(destinationRegions("jp", "us-east-1"), undefined);
  assert.equal(destinationRegions("global", "us-east-1"), undefined);
});
test("every source Region is one of its own destinations except Regions the table lists separately, and no wildcard appears", () => {
  for (const [prefix, map] of Object.entries(GEO_PROFILES)) {
    for (const [src, dests] of Object.entries(map)) {
      assert.ok(dests.includes(src) || prefix === "eu" || prefix === "us", `${prefix} ${src}`);
      for (const d of dests) assert.match(d, /^[a-z]{2}-[a-z]+-\d$/);
    }
  }
  assert.ok(supportedRegions().includes("ap-northeast-1"));
});
