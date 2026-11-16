import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { synthTemplate } from "./helpers";

const CIDR = "203.0.113.10/32";

function containerEnv(captions?: string, captionsJapaneseSpeech?: string): Record<string, string> {
  const t = synthTemplate({
    venueCidr: CIDR,
    eventFile: "none",
    ...(captions ? { captions } : {}),
    ...(captionsJapaneseSpeech ? { captionsJapaneseSpeech } : {}),
  });
  const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition"))[0].Properties.ContainerDefinitions as Array<{
    Environment: Array<{ Name: string; Value: unknown }>;
  }>;
  return Object.fromEntries(defs[0].Environment.map((e) => [e.Name, String(e.Value)]));
}

test("CAPTIONS env var follows the captions setting", () => {
  assert.equal(containerEnv().CAPTIONS, "on");
  assert.equal(containerEnv("off").CAPTIONS, "off");
});

test("CAPTIONS_JA_SPEECH env var follows the captionsJapaneseSpeech setting; everything else is unchanged", () => {
  assert.equal(containerEnv().CAPTIONS_JA_SPEECH, "on");
  assert.equal(containerEnv(undefined, "off").CAPTIONS_JA_SPEECH, "off");
  const on = containerEnv(undefined, "on");
  const off = containerEnv(undefined, "off");
  delete on.CAPTIONS_JA_SPEECH;
  delete off.CAPTIONS_JA_SPEECH;
  assert.deepEqual(off, on);
});
test("captionsJapaneseSpeech does not change the web assets (the page handles the events whenever they arrive)", () => {
  const keys = (v: string): string[] => {
    const t = synthTemplate({ venueCidr: CIDR, eventFile: "none", captionsJapaneseSpeech: v });
    return Object.values(t.findResources("Custom::CDKBucketDeployment"))[0].Properties.SourceObjectKeys as string[];
  };
  assert.deepEqual(keys("on"), keys("off"));
});
test("captions=off leaves everything else in the container environment unchanged", () => {
  const on = containerEnv("on");
  const off = containerEnv("off");
  delete on.CAPTIONS;
  delete off.CAPTIONS;
  assert.deepEqual(off, on);
});

// config.json is an inline asset (a zip), so its content shows in the template only as an asset key.
test("web config.json changes with the captions setting and the page assets do not", () => {
  const keys = (captions: string): string[] => {
    const t = synthTemplate({ venueCidr: CIDR, eventFile: "none", captions });
    const r = Object.values(t.findResources("Custom::CDKBucketDeployment"))[0];
    return r.Properties.SourceObjectKeys as string[];
  };
  const on = keys("on");
  const off = keys("off");
  assert.equal(on[0], off[0], "page files (app/web) are identical");
  assert.notEqual(on[1], off[1], "config.json differs");
});

// The listener grant is pinned exactly: receiving captions needs only canSubscribe; any widening fails here.
test("listener token grants are unchanged: subscribe only, no publish, no data publish", () => {
  const dir = join(__dirname, "..", "lambda", "token", "jwt.mjs");
  const script = `import { mintListenerToken } from ${JSON.stringify("file://" + dir)};
    const t = mintListenerToken({ apiKey: "k", apiSecret: "s", room: "r", ttlSec: 60, identity: "i", nowSec: 1 });
    console.log(Buffer.from(t.split(".")[1], "base64url").toString());`;
  const payload = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.deepEqual(payload.video, {
    room: "r",
    roomJoin: true,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
});
