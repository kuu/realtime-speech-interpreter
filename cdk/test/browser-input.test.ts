import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Template } from "aws-cdk-lib/assertions";
import { synthTemplate } from "./helpers";

const base = { venueCidr: "203.0.113.10/32", eventFile: "none" };
const off = () => synthTemplate({ ...base });
const on = () => synthTemplate({ ...base, inputSource: "browser" });
const types = (t: Template) => {
  const c: Record<string, number> = {};
  for (const r of Object.values(t.toJSON().Resources as Record<string, { Type: string }>)) c[r.Type] = (c[r.Type] ?? 0) + 1;
  return c;
};
const policies = (t: Template) => JSON.stringify(t.findResources("AWS::IAM::Policy"));

test("srt mode deploys nothing browser-related", () => {
  const t = off();
  const json = JSON.stringify(t.toJSON());
  assert.ok(!Object.values(t.findResources("AWS::Lambda::Function")).some((f: any) => f.Properties.ReservedConcurrentExecutions !== undefined));
  for (const word of ["PublisherToken", "PublisherCode", "publisher-not-after", "Permissions-Policy", "/publisher-token", "INGEST_ROOM", "INPUT_SOURCE", "PublisherUrl"]) {
    assert.ok(!json.includes(word), `srt template mentions ${word}`);
  }
  assert.deepEqual(Object.keys(t.toJSON().Outputs).filter((k) => k.startsWith("Publisher")), []);
});

test("explicit inputSource=srt equals the default", () => {
  assert.deepEqual(types(synthTemplate({ ...base, inputSource: "srt" })), types(off()));
  assert.equal(JSON.stringify(synthTemplate({ ...base, inputSource: "srt" }).toJSON()), JSON.stringify(off().toJSON()));
});

test("browser mode adds the publisher resources", () => {
  const t = on();
  t.resourceCountIs("AWS::SecretsManager::Secret", 3);
  t.hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 5, Environment: { Variables: { INGEST_ROOM: "translation-ingest", TOKEN_TTL_SEC: "600" } } });
  const fns = Object.values(t.findResources("AWS::Lambda::Function")) as any[];
  assert.equal(fns.filter((f) => f.Properties.ReservedConcurrentExecutions !== undefined).length, 1, "only the publisher function is throttled");
  const outs = Object.keys(t.toJSON().Outputs);
  for (const k of ["PublisherUrl", "PublisherCodeSecretArn", "PublisherNotAfterParameter", "PublisherIngestRoom"]) assert.ok(outs.includes(k), k);
});

test("browserInputConcurrency follows the setting; 0 is rejected", () => {
  synthTemplate({ ...base, inputSource: "browser", browserInputConcurrency: 2 }).hasResourceProperties("AWS::Lambda::Function", { ReservedConcurrentExecutions: 2 });
  assert.throws(() => synthTemplate({ ...base, inputSource: "browser", browserInputConcurrency: 0 }), /throttle/);
});

test("the listener function cannot read the code secret and has no publish grant in its source", () => {
  const t = on();
  const roles = t.findResources("AWS::IAM::Policy") as Record<string, any>;
  for (const [id, p] of Object.entries(roles)) {
    const json = JSON.stringify(p);
    if (id.startsWith("TokenFunction")) assert.ok(!json.includes("PublisherCodeSecret"), "listener function policy");
  }
  const dir = join(__dirname, "..", "lambda", "token");
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(!/canPublish:\s*true/.test(src), `${f} mints a publish grant`);
    assert.ok(!src.includes("canPublishSources"), f);
  }
});

test("the app task role reads the end time but not the code secret; the execution role neither", () => {
  const t = on();
  const pol = t.findResources("AWS::IAM::Policy") as Record<string, any>;
  let taskHasSsm = false;
  for (const [id, p] of Object.entries(pol)) {
    const stmts = p.Properties.PolicyDocument.Statement as any[];
    const json = JSON.stringify(stmts);
    if (id.startsWith("AppTaskTaskRole")) {
      taskHasSsm = stmts.some((s) => ([] as string[]).concat(s.Action).includes("ssm:GetParameter") && JSON.stringify(s.Resource).includes("parameter/simul-translation/publisher-not-after"));
      assert.ok(!json.includes("PublisherCodeSecret"), "task role must not reference the code secret");
    }
    if (id.startsWith("AppTaskExecutionRole")) assert.ok(!json.includes("PublisherCodeSecret"), "execution role");
    if (id.startsWith("LiveKitInstanceRole") || id.startsWith("LiveKit")) assert.ok(!json.includes("PublisherCodeSecret"), id);
  }
  assert.ok(taskHasSsm, "task role needs ssm:GetParameter on the end-time parameter");
  const publisherPolicy = Object.entries(pol).find(([id]) => id.startsWith("PublisherTokenFunction"));
  assert.ok(publisherPolicy, "publisher function policy");
  assert.ok(!/"Resource":"\*"/.test(JSON.stringify(publisherPolicy![1])), "no wildcard resource");
});

test("the app container gets the browser settings and keeps the SRT ones", () => {
  const t = on();
  const td = Object.values(t.findResources("AWS::ECS::TaskDefinition"))[0] as any;
  const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
  assert.equal(env.INPUT_SOURCE, "browser");
  assert.equal(env.INGEST_ROOM, "translation-ingest");
  assert.equal(env.INGEST_NOT_AFTER_PARAM, "/simul-translation/publisher-not-after");
  assert.equal(env.INGEST_SILENCE_DB, "-60");
  assert.equal(env.INGEST_SILENCE_SEC, "30");
  assert.equal(env.INGEST_SESSION_GRACE_SEC, "60");
  assert.ok(env.SRT_PORT && env.SRT_HOST, "SRT settings stay");
  const srt = Object.values(synthTemplate({ ...base }).findResources("AWS::ECS::TaskDefinition"))[0] as any;
  assert.ok(!srt.Properties.ContainerDefinitions[0].Environment.some((e: any) => e.Name === "INPUT_SOURCE"));
});

test("CloudFront: POST only on /publisher-token, no CORS, CSP without unsafe-inline, microphone policy", () => {
  const t = on();
  const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0] as any;
  const cfg = dist.Properties.DistributionConfig;
  const post = cfg.CacheBehaviors.filter((b: any) => (b.AllowedMethods ?? []).includes("POST")).map((b: any) => b.PathPattern);
  assert.deepEqual(post, ["/publisher-token"]);
  assert.deepEqual(cfg.CacheBehaviors.map((b: any) => b.PathPattern).sort(), ["/publish", "/publish.html", "/publisher-token", "/token"]);
  const rhp = JSON.stringify(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
  assert.ok(!rhp.includes("unsafe-inline"));
  assert.ok(!/Cors/i.test(rhp));
  assert.match(rhp, /https:\/\//);
  assert.match(rhp, /wss:\/\//);
  assert.ok(rhp.includes("microphone=(self)"));
  assert.ok(rhp.includes("script-src 'self'"));
  assert.ok(rhp.includes("no-referrer") || rhp.includes("NoReferrer") || /ReferrerPolicy/.test(rhp));
  t.hasResourceProperties("AWS::CloudFront::Function", { FunctionConfig: { Runtime: "cloudfront-js-2.0" } });
});

test("code secret generator uses only the 31-character alphabet, 12 characters", () => {
  const t = on();
  const sec = Object.values(t.findResources("AWS::SecretsManager::Secret")).find((s: any) => s.Properties.GenerateSecretString?.GenerateStringKey === "code") as any;
  const g = sec.Properties.GenerateSecretString;
  assert.equal(g.PasswordLength, 12);
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (const c of alphabet) assert.ok(!g.ExcludeCharacters.includes(c), c);
  for (const c of "0O1IL".split("")) assert.ok(g.ExcludeCharacters.includes(c), c);
  assert.ok(g.ExcludeCharacters.includes("a") && g.ExcludeCharacters.includes("!"));
});

test("the pinned livekit-client file has the recorded SHA-256 (served from the page's own origin)", () => {
  const f = join(__dirname, "..", "node_modules", "livekit-client", "dist", "livekit-client.esm.mjs");
  const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
  assert.equal(sha, "360c155384ffcbfa53e5ec871b21de945d6017315c466f692904dde8d3a7a888");
  assert.equal(JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).devDependencies["livekit-client"], "2.24.1");
});

test("policies in browser mode mention the parameter ARN only through formatArn (no account id literal)", () => {
  assert.ok(!/\b\d{12}\b/.test(policies(on())));
});
