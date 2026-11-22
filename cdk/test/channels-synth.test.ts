import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parityView, synthTemplate } from "./helpers";

const CIDR = "203.0.113.10/32";
const DEFAULT_LANE = { source: "en-US", target: "ja", pollyVoice: "Kazuha" };
const EN_LANE = { source: "ja-JP", target: "en", pollyVoice: "Joanna" };
const base = { venueCidr: CIDR, eventFile: "none" };
const two = JSON.stringify([DEFAULT_LANE, EN_LANE]);

function env(overrides: Record<string, unknown>): Record<string, string> {
  const t = synthTemplate({ ...base, ...overrides });
  const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition"))[0].Properties.ContainerDefinitions as Array<{
    Environment: Array<{ Name: string; Value: unknown }>;
  }>;
  return Object.fromEntries(defs[0].Environment.map((e) => [e.Name, String(e.Value)]));
}
function terminologyResources(overrides: Record<string, unknown>): string[] {
  const t = synthTemplate({ ...base, ...overrides });
  const out: string[] = [];
  for (const p of Object.values(t.findResources("AWS::IAM::Policy"))) {
    for (const st of p.Properties.PolicyDocument.Statement as Array<{ Action: unknown; Resource: unknown }>) {
      const a = Array.isArray(st.Action) ? st.Action : [st.Action];
      if (a.includes("translate:GetTerminology")) out.push(...(Array.isArray(st.Resource) ? st.Resource : [st.Resource]).map((r) => JSON.stringify(r)));
    }
  }
  return out;
}
const outputs = (o: Record<string, unknown>) => Object.keys(synthTemplate({ ...base, ...o }).toJSON().Outputs ?? {});

test("two lanes: CHANNELS carries both resolved lanes; lane 1 is also the flat variables", () => {
  const e = env({ channels: two });
  const lanes = JSON.parse(e.CHANNELS);
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes[0], { source: "en-US", target: "ja", pollyVoice: "Kazuha", transcribeVocabulary: "simul-translation", translateTerminology: "simul-translation" });
  assert.deepEqual(lanes[1], { source: "ja-JP", target: "en", pollyVoice: "Joanna", transcribeVocabulary: "", translateTerminology: "simul-translation" });
  assert.equal(e.SOURCE_LANGUAGE, "en-US");
  assert.equal(e.TRANSLATE_TARGET, "ja");
  assert.equal(e.POLLY_VOICE, "Kazuha");
  assert.equal(e.LANGUAGE_FILTER, "langid");
});
test("two lanes: the Japanese segmenter and ja-JP settle keys are in the environment", () => {
  const e = env({ channels: two, latencyPreset: "fast" });
  assert.equal(e.JA_SEGMENTATION_MODE, "simple");
  assert.equal(e.JA_MAX_WAIT_MS, "2500");
  assert.equal(e.JA_CLAUSE_MIN_CHARS, "8");
  assert.equal(e.LANGID_SETTLE_ITEMS, "5");
  assert.equal(e.LANGID_SETTLE_ITEMS_DEFAULT, "3");
  assert.equal(e.LANGID_SETTLE_ITEMS_AFTER_EN, "5");
  assert.equal(e.JA_SHORT_CHARS, "4");
  assert.equal("JA_CLAUSE_ENDINGS" in e, false, "empty = built-in list: not set");
  assert.equal(env({ channels: two, jaClauseEndings: "ので,けど" }).JA_CLAUSE_ENDINGS, "ので,けど");
});
test("default and one default lane: no CHANNELS, no JA or items variables, no extra output", () => {
  for (const o of [{}, { channels: JSON.stringify([DEFAULT_LANE]) }]) {
    const e = env(o);
    assert.equal("CHANNELS" in e, false);
    assert.deepEqual(Object.keys(e).filter((k) => /^(JA_|LANGID_SETTLE_ITEMS)/.test(k) && k !== "JA_FILLER_PATTERNS"), []);
    assert.equal(outputs(o).some((k) => k.startsWith("ListenerUrl") && k !== "ListenerUrl"), false);
  }
});
test("a single ja-JP to en lane: flat variables, the Japanese keys, no CHANNELS", () => {
  const e = env({ channels: JSON.stringify([EN_LANE]) });
  assert.equal("CHANNELS" in e, false);
  assert.equal(e.SOURCE_LANGUAGE, "ja-JP");
  assert.equal(e.TRANSLATE_SOURCE, "ja");
  assert.equal(e.TRANSLATE_TARGET, "en");
  assert.equal(e.POLLY_VOICE, "Joanna");
  assert.equal(e.TRANSCRIBE_VOCABULARY, "");
  assert.equal(e.TRANSLATE_TERMINOLOGY, "simul-translation", "the one multi-directional terminology is the default of every lane");
  assert.equal(e.JA_SEGMENTATION_MODE, "simple");
});
test("ListenerUrlEn is added for the second channel only, with ?ch=<id>", () => {
  assert.ok(outputs({ channels: two }).includes("ListenerUrlEn"));
  assert.ok(outputs({ channels: two }).includes("ListenerUrl"));
  const t = synthTemplate({ ...base, channels: two }).toJSON();
  assert.match(JSON.stringify(t.Outputs.ListenerUrlEn.Value), /\/\?ch=en/);
  assert.equal(JSON.stringify(t.Outputs.ListenerUrl.Value).includes("?ch="), false);
  const ja2 = synthTemplate({ ...base, channels: JSON.stringify([EN_LANE, DEFAULT_LANE]) }).toJSON();
  assert.ok(ja2.Outputs.ListenerUrlJa, "the second lane's id names the output");
});
test("IAM: the terminology statement lists exactly the llm lanes' terminologies (one more pair for two lanes)", () => {
  const model = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";
  const one = terminologyResources({ translateEngine: "llm", llmModelId: model });
  assert.equal(one.length, 2);
  const lanes = JSON.stringify([DEFAULT_LANE, { ...EN_LANE, translateTerminology: "t-lane2" }]);
  const both = terminologyResources({ channels: lanes, translateEngine: "llm", llmModelId: model });
  assert.equal(both.length, 4);
  assert.ok(both.some((r) => r.includes("terminology/t-lane2")));
  assert.ok(both.some((r) => r.includes("terminology/simul-translation")));
  const onlyLane2 = JSON.stringify([DEFAULT_LANE, { ...EN_LANE, translateTerminology: "t-lane2", translateEngine: "llm" }]);
  const l2 = terminologyResources({ channels: onlyLane2, llmModelId: model });
  assert.equal(l2.length, 2, "only the llm lane's terminology");
  assert.ok(l2.every((r) => r.includes("t-lane2")));
  assert.deepEqual(terminologyResources({ channels: two }), [], "no llm lane: no statement");
});
test("IAM: two llm lanes with the default (shared) terminology list one pair, not two", () => {
  const model = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";
  const shared = terminologyResources({ channels: two, translateEngine: "llm", llmModelId: model });
  assert.equal(shared.length, 2);
  assert.ok(shared.every((r) => r.includes("terminology/simul-translation")));
});
test("secrets and listener resources are unchanged by a second channel (same LiveKit key, same room)", () => {
  const count = (o: Record<string, unknown>, type: string) => Object.keys(synthTemplate({ ...base, ...o }).findResources(type)).length;
  for (const type of ["AWS::SecretsManager::Secret", "AWS::CloudFront::Distribution", "AWS::EC2::Instance", "AWS::ECS::Service", "AWS::Lambda::Function"]) {
    assert.equal(count({ channels: two }, type), count({}, type), type);
  }
  const secrets = (o: Record<string, unknown>) =>
    Object.values(synthTemplate({ ...base, ...o }).findResources("AWS::SecretsManager::Secret")).map((s) => JSON.stringify(s.Properties.GenerateSecretString));
  assert.deepEqual(secrets({ channels: two }), secrets({}));
});
test("the IAM and security group view of a two-lane deploy equals the default's (nothing broader is granted)", () => {
  const strip = (v: unknown) => {
    const j = JSON.parse(JSON.stringify(v)) as Record<string, any>;
    for (const k of Object.keys(j)) if (Array.isArray(j[k])) j[k] = j[k].map((d: any) => ({ ...d, Environment: undefined }));
    return j;
  };
  assert.deepEqual(strip(parityView(synthTemplate({ ...base, channels: two }))), strip(parityView(synthTemplate({ ...base }))));
});
test("config.json changes for two lanes (asset key) and not for one default lane", () => {
  const keys = (o: Record<string, unknown>) => {
    const t = synthTemplate({ ...base, ...o });
    return Object.values(t.findResources("Custom::CDKBucketDeployment"))[0].Properties.SourceObjectKeys as string[];
  };
  assert.notDeepEqual(keys({ channels: two }), keys({}));
  assert.deepEqual(keys({ channels: JSON.stringify([DEFAULT_LANE]) }), keys({}));
});
