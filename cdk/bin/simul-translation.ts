#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { resolveRegion } from "../lib/config";
import { SimulTranslationStack } from "../lib/simul-translation-stack";

const app = new cdk.App();
const region = resolveRegion(app);

new SimulTranslationStack(app, "SimulTranslation", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  description:
    "Live EN->JA simultaneous translation: SRT ingest (NLB+Fargate), Transcribe/Translate/Polly, self-hosted LiveKit SFU, CloudFront listener page",
});
