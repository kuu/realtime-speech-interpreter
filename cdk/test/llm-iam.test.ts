import { test } from "node:test";
import * as assert from "node:assert/strict";
import { synthTemplate } from "./helpers";

const base = { venueCidr: "203.0.113.10/32", eventFile: "none" };
const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";

function bedrockStatements(overrides: Record<string, unknown>): Array<{ Action: unknown; Resource: unknown[] }> {
  const t = synthTemplate({ ...base, ...overrides });
  const out: Array<{ Action: unknown; Resource: unknown[] }> = [];
  for (const p of Object.values(t.findResources("AWS::IAM::Policy"))) {
    for (const st of p.Properties.PolicyDocument.Statement as Array<{ Action: unknown; Resource: unknown }>) {
      const a = Array.isArray(st.Action) ? st.Action : [st.Action];
      if (a.some((x) => String(x).startsWith("bedrock:"))) out.push({ Action: st.Action, Resource: Array.isArray(st.Resource) ? st.Resource : [st.Resource] });
    }
  }
  return out;
}
const flat = (r: unknown[]) => r.map((x) => JSON.stringify(x));

const fm = (d: string) => JSON.stringify(`arn:aws:bedrock:${d}::foundation-model/${HAIKU}`);
const isProfile = (x: string) => x.includes("inference-profile/");

test("Tokyo (default): the profile ARN plus the two foundation-model ARNs", () => {
  const st = bedrockStatements({});
  assert.equal(st.length, 1);
  assert.equal(st[0].Action, "bedrock:InvokeModel");
  const r = flat(st[0].Resource);
  assert.equal(r.length, 3);
  assert.equal(r.filter(isProfile).length, 1);
  assert.ok(r.filter(isProfile)[0].includes(`inference-profile/jp.${HAIKU}`));
  assert.deepEqual(r.filter((x) => !isProfile(x)).sort(), [fm("ap-northeast-1"), fm("ap-northeast-3")]);
});
test("us-east-1: the us. profile with its three destination Regions, no wildcard", () => {
  const st = bedrockStatements({ region: "us-east-1" });
  assert.equal(st[0].Action, "bedrock:InvokeModel");
  const r = flat(st[0].Resource);
  assert.ok(r.filter(isProfile)[0].includes(`inference-profile/us.${HAIKU}`));
  assert.deepEqual(r.filter((x) => !isProfile(x)).sort(), ["us-east-1", "us-east-2", "us-west-2"].map(fm));
  assert.ok(r.every((x) => !x.includes("*")));
});
test("a Region without a geo profile fails synth and names the Translate alternative", () => {
  assert.throws(() => synthTemplate({ ...base, region: "ap-northeast-2" }), /No Claude Haiku 4\.5 geo inference profile for ap-northeast-2[\s\S]*translateEngine=translate/);
});
test("translateEngine=translate adds no Bedrock statement in any Region, and does not fail where there is no profile", () => {
  for (const region of ["ap-northeast-1", "us-east-1", "ap-northeast-2"]) {
    assert.deepEqual(bedrockStatements({ translateEngine: "translate", region }), [], region);
  }
});
test("an explicit llmModelId with a prefix the Region cannot use, or a global. profile, fails", () => {
  assert.throws(() => synthTemplate({ ...base, region: "us-east-1", llmModelId: `jp.${HAIKU}` }), /cannot be called from us-east-1/);
  assert.throws(() => synthTemplate({ ...base, llmModelId: `global.${HAIKU}` }), /global\." profiles are not supported/);
  assert.throws(() => synthTemplate({ ...base, llmModelId: HAIKU }), /geo inference profile/);
});
