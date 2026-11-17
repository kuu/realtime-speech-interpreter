import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Template } from "aws-cdk-lib/assertions";
import { synthTemplate, cdkJsonContext } from "./helpers";
import { buildLiveKitUserData, rtmpsCaddyfile } from "../lib/livekit-user-data";
import { UD_PROPS } from "./fixtures/user-data-props";

const base = { venueCidr: "203.0.113.10/32,198.51.100.0/24", eventFile: "none" };
const srt = () => synthTemplate({ ...base });
let cached: Template | undefined;
const on = () => (cached ??= synthTemplate({ ...base, inputSource: "rtmps" }));
const res = (t: Template, type: string) => Object.entries(t.findResources(type)) as Array<[string, any]>;
const userData = (t: Template) => JSON.stringify(res(t, "AWS::EC2::Instance")[0][1].Properties.UserData);
const container = (t: Template) => res(t, "AWS::ECS::TaskDefinition")[0][1].Properties.ContainerDefinitions[0];
const RTMPS_WORDS = ["Rtmp", "rtmps", "RTMP_", "caddy-l4", "CaddyL4", "layer4"];

test("srt and browser templates contain nothing RTMPS-related", () => {
  for (const t of [srt(), synthTemplate({ ...base, inputSource: "srt" }), synthTemplate({ ...base, inputSource: "browser" })]) {
    const json = JSON.stringify(t.toJSON());
    for (const w of RTMPS_WORDS) assert.ok(!json.includes(w), `template mentions ${w}`);
    t.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
    // ECR pull exists for the app image (execution role); the LiveKit instance role gets none.
    const lk = res(t, "AWS::IAM::Policy").filter(([k]) => k.startsWith("LiveKitInstanceRole"));
    assert.ok(!JSON.stringify(lk).includes("ecr:"), "LiveKit role has no ECR access");
  }
});

test("srt user data is byte-identical to the golden of today's boot script; caddyImage is the official image", () => {
  const golden = readFileSync(join(__dirname, "fixtures", "livekit-user-data.golden.txt"), "utf8");
  assert.equal(buildLiveKitUserData(UD_PROPS).render() + "\n", golden);
  assert.match(userData(srt()), /-v caddy_config:\/config caddy:2\.11\.7"/);
});

test("rtmps: stream key secret with the SRT generator; regression for the #10 GenerateSecretString lesson", () => {
  const t = on();
  t.resourceCountIs("AWS::SecretsManager::Secret", 3);
  const hit = res(t, "AWS::SecretsManager::Secret").find(([k]) => k.startsWith("RtmpStreamKeySecret"));
  assert.ok(hit, "RtmpStreamKeySecret");
  // Secrets Manager rejects a generator that excludes every character of an included type ("All characters of the
  // desired type have been excluded"); local tests did not catch that for #10. These exact parameters were checked
  // against the service with a no-resource call on 2026-11-17:
  //   aws secretsmanager get-random-password --password-length 32 --exclude-punctuation --no-include-space
  // which returned values matching ^[A-Za-z0-9]{32}$ (3 of 3). Any change here must be re-verified the same way.
  assert.deepEqual(hit[1].Properties.GenerateSecretString, { PasswordLength: 32, ExcludePunctuation: true, IncludeSpace: false });
});

test("rtmps: NLB security group admits the RTMP port only from the LiveKit EIP /32", () => {
  const t = on();
  const [, nlbSg] = res(t, "AWS::EC2::SecurityGroup").find(([k]) => k.startsWith("NlbSg"))!;
  const tcp = (nlbSg.Properties.SecurityGroupIngress as any[]).filter((r) => r.IpProtocol === "tcp");
  assert.equal(tcp.length, 1);
  assert.equal(tcp[0].FromPort, 1935);
  assert.equal(tcp[0].ToPort, 1935);
  assert.deepEqual(tcp[0].CidrIp, { "Fn::Join": ["", [{ Ref: "LiveKitEip" }, "/32"]] });
  // No other way in on that port: no venue CIDR, no 0.0.0.0/0, no rule naming the LiveKit SG.
  for (const r of res(t, "AWS::EC2::SecurityGroupIngress").map(([, x]) => x.Properties).filter((r) => r.FromPort === 1935)) {
    assert.ok(r.SourceSecurityGroupId, "standalone 1935 rules must be SG-to-SG");
    assert.ok(!JSON.stringify(r.SourceSecurityGroupId).includes("LiveKitSg"), "no rule references the LiveKit SG");
    assert.ok(!JSON.stringify(r.GroupId).includes("NlbSg"), "NlbSg has no standalone 1935 rule");
  }
});

test("rtmps: app SG takes the RTMP port only from the NLB SG", () => {
  const t = on();
  const [, appSg] = res(t, "AWS::EC2::SecurityGroup").find(([k]) => k.startsWith("AppSg"))!;
  assert.ok(!((appSg.Properties.SecurityGroupIngress ?? []) as any[]).some((r) => r.FromPort === 1935));
  const rules = res(t, "AWS::EC2::SecurityGroupIngress").map(([, r]) => r.Properties).filter((r) => r.FromPort === 1935);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].IpProtocol, "tcp");
  assert.match(JSON.stringify(rules[0].GroupId), /AppSg/);
  assert.match(JSON.stringify(rules[0].SourceSecurityGroupId), /NlbSg/);
});

test("rtmps: TCP listener and target group, client IP not preserved, TCP health check on healthPort; SRT unchanged", () => {
  const t = on();
  t.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 2);
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 1935, Protocol: "TCP" });
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 9000, Protocol: "UDP" });
  const tgs = res(t, "AWS::ElasticLoadBalancingV2::TargetGroup").map(([, r]) => r.Properties);
  const rtmp = tgs.find((p) => p.Protocol === "TCP")!;
  assert.equal(rtmp.Port, 1935);
  assert.equal(rtmp.TargetType, "ip");
  assert.equal(rtmp.HealthCheckProtocol, "TCP");
  assert.equal(rtmp.HealthCheckPort, "8080");
  const attrs = Object.fromEntries((rtmp.TargetGroupAttributes as any[]).map((a) => [a.Key, a.Value]));
  assert.equal(attrs["preserve_client_ip.enabled"], "false");
  assert.equal(attrs["deregistration_delay.timeout_seconds"], "5");
  assert.deepEqual(tgs.find((p) => p.Protocol === "UDP"), res(srt(), "AWS::ElasticLoadBalancingV2::TargetGroup")[0][1].Properties);
});

test("rtmps: task gets INPUT_SOURCE, RTMP_HOST/PORT, the key as a secret and the TCP port mapping", () => {
  const c = container(on());
  const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
  assert.equal(env.INPUT_SOURCE, "rtmps");
  assert.equal(env.RTMP_HOST, "0.0.0.0");
  assert.equal(env.RTMP_PORT, "1935");
  assert.ok(!("RTMP_STREAM_KEY" in env), "the key is never a plain env var");
  assert.ok(!("INGEST_ROOM" in env), "no browser settings");
  const secret = c.Secrets.find((s: any) => s.Name === "RTMP_STREAM_KEY");
  assert.match(JSON.stringify(secret.ValueFrom), /RtmpStreamKeySecret/);
  assert.deepEqual(c.PortMappings.find((m: any) => m.ContainerPort === 1935), { ContainerPort: 1935, Protocol: "tcp" });
});

test("rtmps: instance role may pull the Caddy image only (auth token on *, pull on one repository, no push)", () => {
  const t = on();
  const [, pol] = res(t, "AWS::IAM::Policy").find(([k]) => k.startsWith("LiveKitInstanceRole"))!;
  const stmts = pol.Properties.PolicyDocument.Statement as any[];
  const ecr = stmts.filter((s) => JSON.stringify(s.Action).includes("ecr:"));
  const actions = ecr.flatMap((s) => ([] as string[]).concat(s.Action)).sort();
  assert.deepEqual(actions, ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer"]);
  for (const s of ecr) {
    const a = ([] as string[]).concat(s.Action);
    if (a.includes("ecr:GetAuthorizationToken")) assert.deepEqual(a, ["ecr:GetAuthorizationToken"]);
    else assert.notEqual(s.Resource, "*", "pull actions are scoped to the asset repository");
  }
  assert.ok(!/ecr:(Put|Upload|InitiateLayerUpload|CompleteLayerUpload|Delete)/.test(JSON.stringify(stmts)));
});

test("rtmps: boot script validates the layer4 config before Caddy starts, keeps the wss site, no secret value", () => {
  const ud = userData(on());
  const validate = ud.indexOf("caddy validate --config /etc/caddy/Caddyfile");
  assert.ok(validate > 0 && validate < ud.indexOf("--name caddy"));
  assert.ok(ud.indexOf("login --username AWS") < validate);
  for (const s of ["not tls alpn acme-tls/1", "tls sni rtmps.", "@denied not remote_ip 203.0.113.10/32 198.51.100.0/24", "reverse_proxy 127.0.0.1:7880", "respond 404", "close"]) {
    assert.ok(ud.includes(s), s);
  }
  assert.equal(ud.split("disable_http_challenge").length - 1, 2, "both names use TLS-ALPN-01 only");
  assert.match(ud, /proxy ",\{"Ref":"SrtEip1"\},":1935/);
  assert.ok(!ud.includes("RtmpStreamKeySecret"), "the instance never sees the stream key");
  assert.ok(!/caddy_config:\/config caddy:2\.11\.7/.test(ud), "custom image replaces the official one");
  for (const local of ["skip_install_trust", "admin off", "cert_issuer", "bind 127.0.0.1"]) assert.ok(!ud.includes(local), local);
});

test("rtmpsCaddyfile: the RTMPS matcher excludes the ACME challenge and the deny route comes first", () => {
  const lines = rtmpsCaddyfile("lk.example.test", {
    name: "rtmps.lk.example.test", venueCidrs: ["203.0.113.10/32"], upstream: "203.0.113.30:1935", image: "x",
  });
  const text = lines.join("\n");
  assert.ok(text.indexOf("@denied not remote_ip") < text.indexOf("proxy 203.0.113.30:1935"));
  assert.ok(text.indexOf("route @denied") < text.indexOf("              tls\n"));
  assert.match(text, /@rtmps \{\n\s+tls sni rtmps\.lk\.example\.test\n\s+not tls alpn acme-tls\/1\n/);
});

test("rtmps: outputs give the URL, the key command and no secret value", () => {
  const outs = on().toJSON().Outputs as Record<string, any>;
  assert.deepEqual(outs.RtmpsUrl.Value, { "Fn::Join": ["", ["rtmps://rtmps.", { Ref: "LiveKitEip" }, ".sslip.io:443/live"]] });
  assert.match(outs.RtmpsUrl.Description, /IP address/);
  assert.ok(outs.RtmpsStreamKeyNote && outs.RtmpsStreamKeySecretArn);
  const cmd = JSON.stringify(outs.GetRtmpsStreamKeyCommand.Value);
  assert.match(cmd, /aws secretsmanager get-secret-value --region .* --secret-id /);
  assert.match(cmd, /--query SecretString --output text/);
  assert.match(cmd, /RtmpStreamKeySecret/);
  assert.equal(JSON.stringify(outs.GetSrtPassphraseCommand), JSON.stringify((srt().toJSON().Outputs as any).GetSrtPassphraseCommand));
});

test("caddy-l4 Dockerfile: pinned Caddy version equals caddyImage, digests and a full caddy-l4 commit", () => {
  const df = readFileSync(join(__dirname, "..", "caddy-l4", "Dockerfile"), "utf8");
  const tag = String(cdkJsonContext().caddyImage).split(":")[1];
  const esc = tag.replace(/\./g, "\\.");
  const froms = df.split("\n").filter((l) => l.startsWith("FROM "));
  assert.equal(froms.length, 2);
  for (const f of froms) assert.match(f, new RegExp(`caddy:${esc}(-builder)?@sha256:[0-9a-f]{64}`));
  assert.match(df, new RegExp(`ARG CADDY_VERSION=v${esc}\\n`));
  assert.match(df, /ARG CADDY_L4_COMMIT=[0-9a-f]{40}\n/);
  assert.match(df, /--with github\.com\/mholt\/caddy-l4@\$CADDY_L4_COMMIT/);
  assert.match(df, /ARG GOPROXY=https:\/\/proxy\.golang\.org,direct\n/, "no third-party mirror in the default");
});
