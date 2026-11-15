import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { SimulTranslationStack } from "../lib/simul-translation-stack";

/** cdk.json "context" as the CDK CLI would merge it (everything except -c overrides). */
export function cdkJsonContext(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(__dirname, "..", "cdk.json"), "utf8")) as { context: Record<string, unknown> };
  return raw.context;
}

/** Context as the CLI passes it: cdk.json defaults overlaid with -c style overrides. */
export function makeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...cdkJsonContext(), ...overrides };
}

export function synthTemplate(overrides: Record<string, unknown>): Template {
  const app = new cdk.App({ context: makeContext(overrides) });
  const stack = new SimulTranslationStack(app, "SimulTranslation");
  return Template.fromStack(stack);
}

const PARITY_TYPES = [
  "AWS::IAM::Role",
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::SecurityGroupIngress",
  "AWS::EC2::SecurityGroupEgress",
];

/** The parts of a template the config changes must not alter: container env, IAM, security groups. */
export function parityView(t: Template): unknown {
  const json = t.toJSON() as { Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> };
  const out: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(json.Resources)) {
    if (PARITY_TYPES.includes(r.Type)) out[id] = r;
    if (r.Type === "AWS::ECS::TaskDefinition") {
      const defs = (r.Properties?.ContainerDefinitions ?? []) as Array<Record<string, unknown>>;
      out[id] = defs.map((d) => ({ Name: d.Name, Environment: d.Environment, Secrets: d.Secrets, Cpu: d.Cpu, Memory: d.Memory }));
    }
    if (r.Type === "AWS::EC2::Instance" || r.Type === "AWS::EC2::LaunchTemplate") {
      out[id] = { Type: r.Type, Properties: r.Properties };
    }
  }
  return out;
}
