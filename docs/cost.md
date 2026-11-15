# Cost

What this stack costs on AWS, which resources are billed, and how to stop paying.

**Prices as of 2026-11-15, region ap-northeast-1 (Tokyo), USD, list price, tax excluded.** No free tier, discount,
credit or Savings Plan is applied. Prices were read from the AWS Price List API (`aws pricing get-products --region
us-east-1`, read only) and are stored with their usage types in [`scripts/cost-prices.json`](../scripts/cost-prices.json).
Prices change. Check the current price pages before you budget, and see "Update the prices" below.

## Summary

| Case | Cost |
|---|---|
| Running session, LLM engine (the `talk` profile), 100 listeners | about **$2.4 per hour** ($9.7 for a 4 hour event) |
| Running session, Amazon Translate engine, 100 listeners | about **$2.0 per hour** ($7.8 for 4 hours) |
| Stack left deployed, nobody speaking (as deployed) | about **$0.20 per hour, $4.9 per day, $147 per 30 days** |
| After setting the ECS desired count to 0 | about $3.6 per day |
| Also with the LiveKit instance stopped | about $1.0 per day |
| After `cdk destroy` | about $0.003 per day (the app image in the CDK bootstrap repository) |

75-80% of a running hour is the speech services: Transcribe ($0.60), Bedrock or Translate, and Polly ($0.40).
With 100 listeners, outbound audio adds about $0.27. Listener count is the main variable (see "Sensitivity").

Captions add no AWS service: the text already exists in the app. They are sent as LiveKit data packets to every
listener who pressed **Listen**. Measured on a local LiveKit server over a 2-minute talk: about 370 bytes per second
per listener on average (peak about 1 KB/s, at most 5 packets per second), next to about 14 KB/s for the audio. The
captions do not add participants; capacity and the listener estimate are unchanged.

## Which numbers are measured and which are estimates

| Number | Status | Source |
|---|---|---|
| Unit prices | Read from the AWS Price List API on 2026-11-15 | `scripts/cost-prices.json` |
| Fargate size (1 vCPU, 2 GB, ARM64), EC2 type, EBS size, number of Elastic IPs and secrets | Read from the stack (`cdk/cdk.json`, `cdk/lib/simul-translation-stack.ts`) | the calculator reads `cdk.json` and `event.json` |
| About 1,130 chunks per hour, 22 Japanese characters per chunk to Polly (24,900 per hour), 28 English characters per chunk to Translate (31,900 per hour) | **Measured**: one cloud run of 2,389 s of recorded English speech with the fast chunking profile and the LLM engine, counted from the app log (750 synthesized chunks) | e2e run logs |
| LLM tokens per call: 126 uncached input, 5,470 cache read, 16.5 output (745 calls) | **Measured**, same run. An earlier run with the default chunking measured about 150, 5,190 and 25 per call | e2e run logs, LLM engine report |
| App log volume, about 0.93 MB per hour | **Measured**, same run | e2e run log size |
| Transcribe seconds | Equal to the audio duration (3,600 s per hour). A day of runs billed 105% of the clip seconds | pricing page, billing check |
| Audio bitrate to listeners (32 kbps plus 20 kbps of RTP/UDP/IP headers per listener) | **Estimate**, not measured. The bitrate LiveKit uses for this track was not verified. | `--opus-kbps` |
| LiveKit and token function log volume (18% of the app log) | Estimate, from stored log bytes | |
| NLB capacity units (1 LCU per hour used as an upper bound), CloudFront and Lambda per listener, EBS 20 GB, image size 1 GB | Estimate or read from code. All of them are below $0.01 per hour | |
| Cost of a Polly SSML `<sub>` alias | Not verified. The estimate counts the spoken text length. | |

The recorded talks used for the measurement are not published. Real speech differs: a talk with long pauses produces
fewer chunks and characters, a talk with little silence produces more.

## Every billed resource

| Service | Resource | Pricing dimension | Price | Billed |
|---|---|---|---|---|
| ECS Fargate | App task (ARM64) | vCPU-hours (1 vCPU) + GB-hours (2 GB) | $0.04045 per vCPU-h, $0.00442 per GB-h | while the task runs (desired count 1) |
| Elastic Load Balancing | Network Load Balancer for SRT | NLB-hours + LCU-hours | $0.0243 per h, $0.006 per LCU-h | while it exists |
| VPC (public IPv4) | 2 Elastic IPs on the NLB (one per AZ) | address-hours | $0.005 per h each | while allocated |
| VPC (public IPv4) | 1 Elastic IP on the LiveKit instance | address-hours | $0.005 per h | while allocated, also while the instance is stopped |
| VPC (public IPv4) | Public IP of the Fargate task (no NAT gateway) | address-hours | $0.005 per h | while a task runs |
| EC2 | LiveKit server, c6i.large | instance-hours | $0.107 per h | while running |
| EBS | Root volume 20 GB gp3 | GB-months | $0.096 per GB-month | while the volume exists, also while the instance is stopped |
| Secrets Manager | 2 secrets (LiveKit API key, SRT passphrase) | secret-months + API calls | $0.4 per secret-month, $0.05 per 10,000 calls | while they exist |
| CloudFront | Listener page and /token behavior | HTTPS requests + data transfer out | $0.012 per 10,000, $0.114 per GB | per listener join |
| S3 | Site bucket | GB-months + requests | $0.025 per GB-month | a few KB stored |
| Lambda | Token function (ARM64, 128 MB) | requests + GB-seconds | $0.0000002 per request | per listener join |
| CloudWatch Logs | 3 log groups (app, livekit, token) | GB ingested + GB-months stored | $0.76 per GB, $0.033 per GB-month | per log volume, retention from logRetentionDays |
| Data transfer | LiveKit audio to listeners (EC2 to internet) | GB out | $0.114 per GB | listeners x bitrate x time |
| Transcribe | Streaming transcription with language identification | seconds of audio | $0.0001667 per s (about $0.01 per min) | while audio is sent |
| Translate | TranslateText (translate engine, and fallback of the llm engine) | characters | $0.000015 per character | per translated chunk |
| Polly | SynthesizeSpeech, neural voice | characters | $0.000016 per character | per spoken chunk |
| Bedrock | Claude Haiku 4.5 via the jp. inference profile (llm engine only) | input, output, cache-read and cache-write tokens | $1.1 in, $5.5 out, $0.11 cache read, $1.375 cache write, per million tokens | per chunk |
| ECR (CDK bootstrap) | App container image | GB-months | $0.1 per GB-month | stays after cdk destroy |
| Free of charge | Transcribe custom vocabulary, Translate terminology, ECS cluster, VPC, subnets, security groups, IAM, CloudFormation | none | $0 | - |

Notes:

- Transcribe streaming bills per second of audio. The AWS Transcribe pricing page says the price includes custom
  vocabularies and language identification, so identification adds no separate charge. The custom vocabulary and
  the Translate terminology (both created by `dictionaries.sh`) are free. The stack uses no Polly lexicons.
- SRT audio arriving from OBS is inbound data transfer, which AWS does not charge. The app calls Transcribe, Translate, Polly
  and Bedrock in the same Region, and no internet data transfer charge is added for that in this estimate. This was not checked against a bill.
- There is no NAT gateway (the stack uses public subnets only), so no NAT hourly or per-GB charge.
- The `jp.` Bedrock profile is priced about 10% above the global profile. The calculator uses the `jp.` price by default
  (`--bedrock-price global` for the other).
- Other things you may have created outside the stack and that bill separately: the dictionaries bucket, the Transcribe
  vocabulary and the Translate terminology (free), the CDK bootstrap bucket and image repository.

## Cost per hour of a session

Typical session: 4 hours, 100 listeners, one speaker, the `talk` profile (about 1,130 chunks per hour), Transcribe
receiving 60 minutes of audio per hour. LLM engine:

| Item | USD per hour | Share |
|---|---|---|
| Fargate task (vCPU + memory) | $0.049 | 2.0% |
| Network Load Balancer (hour + LCU) | $0.030 | 1.3% |
| Public IPv4 addresses (2 NLB, 1 LiveKit, 1 Fargate task) | $0.020 | 0.8% |
| EC2 c6i.large (LiveKit) | $0.107 | 4.4% |
| EBS gp3 20 GB (LiveKit) | $0.0026 | 0.1% |
| Secrets Manager (2 secrets, monthly fee prorated) | $0.0011 | 0.0% |
| Transcribe streaming (3,600 s of audio) | $0.600 | 24.9% |
| Translate | $0.0048 | 0.2% |
| Polly neural | $0.398 | 16.5% |
| Bedrock Haiku 4.5 (input + cache read + output) | $0.930 | 38.5% |
| Bedrock cache write (once per start, spread over the session) | $0.0018 | 0.1% |
| CloudWatch Logs ingestion | $0.0008 | 0.0% |
| Data transfer out to listeners (LiveKit audio) | $0.267 | 11.1% |
| CloudFront + S3 + Lambda (listener page and token, once per listener) | $0.0001 | 0.0% |
| Secrets Manager API calls (per session) | $0.0000 | 0.0% |
| Total per hour | $2.41 | 100% |
| Total for 4 h | $9.65 |  |

Same session with the Amazon Translate engine (`translateEngine=translate`):

| Item | USD per hour | Share |
|---|---|---|
| Fargate task (vCPU + memory) | $0.049 | 2.5% |
| Network Load Balancer (hour + LCU) | $0.030 | 1.5% |
| Public IPv4 addresses (2 NLB, 1 LiveKit, 1 Fargate task) | $0.020 | 1.0% |
| EC2 c6i.large (LiveKit) | $0.107 | 5.5% |
| EBS gp3 20 GB (LiveKit) | $0.0026 | 0.1% |
| Secrets Manager (2 secrets, monthly fee prorated) | $0.0011 | 0.1% |
| Transcribe streaming (3,600 s of audio) | $0.600 | 30.7% |
| Translate | $0.480 | 24.5% |
| Polly neural | $0.398 | 20.3% |
| CloudWatch Logs ingestion | $0.0008 | 0.0% |
| Data transfer out to listeners (LiveKit audio) | $0.267 | 13.6% |
| CloudFront + S3 + Lambda (listener page and token, once per listener) | $0.0001 | 0.0% |
| Secrets Manager API calls (per session) | $0.0000 | 0.0% |
| Total per hour | $1.96 | 100% |
| Total for 4 h | $7.82 |  |

With the LLM engine, only fallback chunks (about 1%) go to Translate.

## Cost when nothing is running

These resources bill by the hour while they exist, with no session:

| State | USD per hour | USD per day | USD per 30 days |
|---|---|---|---|
| Left deployed as is (ECS desired count 1) | $0.204 | $4.91 | $147.21 |
| ECS desired count 0 | $0.150 | $3.60 | $108.12 |
| ECS desired count 0 and LiveKit instance stopped | $0.043 | $1.04 | $31.08 |
| After cdk destroy (CDK bootstrap image storage only) | $0.0001 | $0.0033 | $0.099 |

Left as deployed (ECS desired count 1), the stack costs about $4.9 per day, mainly the Fargate task, the EC2 host and the
Network Load Balancer. The Fargate task waits for audio and does not call Transcribe, Translate, Polly or Bedrock until
OBS connects.

## How to stop paying

| Action | Command | Saves per hour | Still billed |
|---|---|---|---|
| Stop the app task | `aws ecs update-service --cluster <EcsClusterName> --service <EcsServiceName> --desired-count 0 --region ap-northeast-1` | about $0.054 (Fargate $0.049 and the task's public IPv4 $0.005) | NLB, 3 Elastic IPs, EC2, EBS, secrets |
| Stop the LiveKit instance | `aws ec2 stop-instances --instance-ids <LiveKitInstanceId> --region ap-northeast-1` | $0.107 | The Elastic IP ($0.005 per hour, a stopped instance keeps it), the EBS volume ($0.003 per hour), everything else |
| Delete the stack | `cd cdk && npx cdk destroy` | everything the stack created | The CDK bootstrap bucket and image repository (cents per month), anything `dictionaries.sh` created, and Secrets Manager secrets while they are in their recovery period (not verified) |

Both stop actions are reversible: `./e2e/e2e.sh check --fix` restores the task and the instance, or set the desired count
back to 1 and start the instance. A new `cdk deploy` resets the desired count to the configured value. The Network Load
Balancer cannot be paused, so `cdk destroy` is the only way to stop its $0.024 per hour. Restarting the LiveKit instance was not tested for
this document, so run a check before the event ([operations](operations.md)).

## Sensitivity

LLM engine against Translate (same speech, `talk` profile, 1,130 chunks per hour):

| | Translate engine | LLM engine | Difference |
|---|---|---|---|
| Per hour | $0.48 Translate | $0.93 Bedrock + $0.005 Translate | about +$0.46 |
| 4 hours | $1.9 | $3.7 | about +$1.8 |

The LLM engine costs about $2 more per 4 hours at the fast profile. The earlier LLM engine report measured about $2.0 of Bedrock
per 4 hours (at list price, 650 chunks per hour) against about $1.1 for Translate at the same chunk rate. Chunk rate drives both:
the fast profile cuts speech into more, shorter chunks. Each Bedrock call re-reads the cached glossary (about 5,500 tokens),
so the LLM cost grows with the number of chunks and not with their length. Cache reads are about 70% of the Bedrock cost.

Listener count (outbound audio at 32 + 20 kbps per listener, $0.114 per GB, the LiveKit instance size follows the listener tier):

| Listeners | LiveKit instance | Transfer per hour | Total per hour, LLM | Total per hour, Translate |
|---|---|---|---|---|
| 10 | c6i.large | $0.03 | $2.17 | $1.72 |
| 100 | c6i.large | $0.27 | $2.41 | $1.96 |
| 300 | c6i.large | $0.80 | $2.95 | $2.49 |
| 301 | c6i.xlarge | $0.80 | $3.06 | $2.60 |
| 1,000 | c6i.xlarge | $2.67 | $4.92 | $4.46 |

Above about 50 listeners, outbound audio is the second biggest cost after the speech services. The bitrate is an estimate: measure
it once with your own LiveKit settings (CloudWatch `NetworkOut` of the instance during a session, divided by listeners) and
pass `--opus-kbps`. The instance tiers are an estimate, not load-tested (see [configuration](configuration.md)).
Speaker time matters too: a quiet room that is not speaking still bills Transcribe, because audio is streamed continuously.

## Calculator

```bash
node scripts/estimate-cost.mjs --hours 4 --listeners 100 --engine llm
node scripts/estimate-cost.mjs --hours 8 --listeners 300 --engine translate --idle-days 2
node scripts/estimate-cost.mjs --help
```

It reads the task size, instance type and log retention from `cdk/cdk.json`, plus `cdk/config/event.json` (profile, engine, `expectedListeners`,
`advanced`) when you have one. Options: `--hours`, `--listeners`, `--engine translate|llm`, `--chunks-per-hour`, `--idle-days`,
`--polly-chars-per-hour`, `--translate-chars-per-hour`, `--llm-in`, `--llm-cache-read`, `--llm-out`, `--llm-call-share`,
`--bedrock-price regional|global`, `--opus-kbps`, `--instance-type`, `--markdown`, `--json`. It lists all billed resources, the per-hour table and the
idle table. It has no dependencies and calls no AWS API. The tables in this document come from it with `--markdown`.

### Check against a measured case

The LLM engine report measured the Haiku 4.5 calls of three recorded talks in local runs. For the longest one it counted
54 calls in 300 s of speech, 150 uncached input tokens, about 5,190 cache-read tokens and 25 output tokens per call,
and priced them at about $2.06 per 4 hours (list price, global profile) and about $2.3 with the `jp.` premium.

```bash
node scripts/estimate-cost.mjs --hours 4 --engine llm --listeners 0 --chunks-per-hour 650 \
  --llm-in 150 --llm-cache-read 5185 --llm-out 25 --llm-call-share 1 --bedrock-price global --json
```

The calculator's Bedrock line is $0.5158 per hour, which is $2.063 for 4 hours, against $2.06 in the report (0.1%). With the `jp.`
price it is $2.27 against "about $2.3". The same inputs for Translate (650 chunks per hour, 28 characters per chunk) give $1.10 for 4 hours, against $1.06
in the `talk` profile description for a measured 4 hour session (4% apart). This check only shows that the calculator multiplies the same measured
tokens and prices in the same way. It is not an independent check of the AWS bill. I tried to reconcile with Cost Explorer for the test days: billed
quantities were 55-65% of the character and token counts in the app logs, and the billed price per unit was below the list price (the account has discounts or
credits), so the bill neither confirms nor contradicts the list-price numbers. Treat the LLM and Polly figures as an upper bound for the same speech.

## Update the prices

```bash
aws pricing get-products --region us-east-1 --service-code AmazonPolly \
  --filters Type=TERM_MATCH,Field=regionCode,Value=ap-northeast-1 --output json
```

Use the service codes and usage types listed in `scripts/cost-prices.json` (`AmazonECS`, `AWSELB`, `AmazonVPC`, `AmazonEC2`, `AmazonCloudFront`,
`AmazonS3`, `AWSLambda`, `AWSSecretsManager`, `AmazonCloudWatch`, `AWSDataTransfer`, `transcribe`, `translate`, `AmazonPolly`,
`AmazonBedrockFoundationModels`, `AmazonECR`), edit the file and change `asOf`. The price pages are the reference when the API is not available:
[Transcribe](https://aws.amazon.com/transcribe/pricing/), [Translate](https://aws.amazon.com/translate/pricing/),
[Polly](https://aws.amazon.com/polly/pricing/), [Bedrock](https://aws.amazon.com/bedrock/pricing/),
[Fargate](https://aws.amazon.com/fargate/pricing/), [Elastic Load Balancing](https://aws.amazon.com/elasticloadbalancing/pricing/),
[VPC public IPv4](https://aws.amazon.com/vpc/pricing/), [EC2](https://aws.amazon.com/ec2/pricing/on-demand/),
[CloudFront](https://aws.amazon.com/cloudfront/pricing/), [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/),
[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/).
This is not a quote. Your bill can differ because of discounts, credits, taxes, free tiers and usage this document does not model.
