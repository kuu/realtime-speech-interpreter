# Architecture decisions

Why the stack is built the way it is. Each record has the context, the decision, the alternatives and why they were
not chosen, and the trade-offs you accept. The details live in the linked pages; this page does not repeat them.
Prices are those of [cost.md](cost.md) (Tokyo, list price, 2026-11-15).

| # | Decision | Short answer |
|---|---|---|
| [1](#1-managed-services-for-the-pipeline-self-managed-livekit-and-caddy) | Managed services, and where compute runs | AWS services for everything except the WebRTC server. App on Fargate, LiveKit and Caddy on one EC2 instance. |
| [2](#2-a-network-load-balancer-in-front-of-one-fargate-task) | NLB in front of one task | Fixed, allow-listable ingest IPs and health-checked replacement. |
| [3](#3-bedrock-for-translation-amazon-translate-as-the-backup) | Bedrock default, Translate backup | Context and glossary quality for about $0.46 more per hour. |
| [4](#4-livekit-as-the-media-server) | LiveKit | Publishes audio-only from a server SDK, plays in any browser. |
| [5](#5-synchronous-calls-and-streams-per-hop) | Sync versus streaming | Streams where the data is continuous, one synchronous call per chunk elsewhere. |
| [6](#6-where-tls-and-encryption-end) | Where encryption ends | Per hop, with one plain-RTMP hop in the optional RTMPS input. |
| [7](#7-decisions-documented-elsewhere) | Inputs, language ID, two channels, dictionaries, one stack | Short records with links. |

## 1. Managed services for the pipeline, self-managed LiveKit and Caddy

**Context.** One speaker, one audio stream, a few hours per event, a spiky audience. Nobody should be on call to patch
servers during an event. Two components do not exist as AWS services: a WebRTC server that accepts a server-side
audio publisher (see [record 4](#4-livekit-as-the-media-server)) and a TLS terminator for it that works without an owned domain.

**Decision.**

| Part | Choice | Why | Operating cost of the choice |
|---|---|---|---|
| Speech to text, translation, speech, LLM | Transcribe, Translate, Bedrock, Polly | Pay per second, character or token; no model hosting; no capacity to size for one stream. | Per-request limits and throttling are AWS's. The app falls back from Bedrock to Translate on failure (record 3). |
| Listener page and token | CloudFront, private S3 bucket, Lambda function URL | No server to patch; scales with listeners; costs below $0.01 per hour ([cost.md](cost.md#cost-per-hour-of-a-session)). | None to operate. |
| Secrets | Secrets Manager | Generated at deploy, injected into the task, never in the template or in user data. | $0.40 per secret-month. |
| App | ECS on Fargate, 1 task, ARM64 | See below. | No OS patching. Image is rebuilt on `cdk deploy`. |
| LiveKit and Caddy | Two containers on one EC2 instance (`c6i.large` by default) with an Elastic IP | See below. | You own the OS image updates and restarts (Docker `--restart unless-stopped` restarts the containers, not the instance). One instance is the scaling limit, tiers are estimates and not load-tested ([cost.md](cost.md#sensitivity), [configuration.md](configuration.md)). |

**Why the app is on Fargate.** It needs no fixed address: it only makes outbound calls, and browsers and the venue
never connect to it directly (the NLB does, see record 2). ECS replaces a task that stops. The service sets a
deployment circuit breaker with rollback, so a bad deploy fails in minutes and returns to the last working task
definition (`circuitBreaker: { enable: true, rollback: true }` in `cdk/lib/simul-translation-stack.ts`). The image is
a CDK asset built from `app/`. There is no OS to patch. The desired count stays at 1 with `minHealthyPercent: 0`, so a
deploy stops the old task before the new one starts; two publishers with the same identity must not run at once.

**Why LiveKit and Caddy are on EC2.** The browsers connect to the media server itself:

- The address is fixed. The stack allocates an Elastic IP, gives it to LiveKit as `node_ip` (the address it advertises in
  ICE candidates) and builds the name `<IP>.sslip.io` from it (`livekit-user-data.ts`, `livekitHostname` in
  [configuration.md](configuration.md)). A Fargate task cannot hold an Elastic IP.
- WebRTC media needs a directly reachable UDP port range (`livekitUdpPortStart`..`End`, 50000-60000 in
  [security.md](security.md#what-is-public)) plus ICE/TCP on 7881 as a fallback. The container runs with `--network host`.
- Caddy must answer on port 443 to get a Let's Encrypt certificate for the `sslip.io` name using TLS-ALPN-01, so
  port 80 stays closed and no domain is needed.

**Alternatives.**

| Alternative | Why not |
|---|---|
| Both on Fargate | No Elastic IP per task, so the advertised address and the certificate name would change at every restart. A directly reachable UDP port range is not what Fargate with an NLB is built for. Not tested here. |
| Both on EC2 | Gives up the managed restart, rollback and image build for the app, and puts a CPU-heavy decode (ffmpeg) and the AI calls on the media host. The app would also need its own fixed address for SRT. |
| App on the LiveKit instance | Removes the NLB, but then one host carries ingest, decode and all WebRTC connections, a host restart stops everything, and the venue allowlist would share a host that is also public for WebRTC. Not tested here. |

**Consequences.** The only server you patch is the LiveKit host. Replacing it (a boot-script change replaces the
instance) keeps the Elastic IP and costs a short outage ([alternative-inputs.md](alternative-inputs.md)). Idle cost is
about $0.20 per hour as deployed, or $0.043 per hour with the task at zero and the instance stopped ([cost.md](cost.md#cost-when-nothing-is-running)).

Detail: [architecture.md](architecture.md#components), [configuration.md](configuration.md), [cost.md](cost.md).

## 2. A Network Load Balancer in front of one Fargate task

**Context.** The venue encoder sends SRT (UDP) to AWS. The venue wants one or two fixed addresses to allow. The app
runs as one task that never scales out (one publisher identity).

**Decision.** An internet-facing NLB with one Elastic IP per Availability Zone (two), a UDP listener on the SRT port, and
the task as target. The health check is a TCP check on the app's health port, because UDP cannot be health-checked
(comment in the stack). The NLB security group allows only `venueCidr`; the task security group allows the venue too,
because UDP to IP targets preserves the client address.

**Why an NLB for one task.**

- A Fargate task cannot attach an Elastic IP and gets a new public IP on every restart. The NLB's Elastic IPs do not change,
  so the encoder URL and the venue's allowlist stay valid when ECS replaces the task.
- Replacement is health-checked: the NLB sends traffic only to a healthy target, so the encoder keeps the same address
  while the task is replaced. The stream itself restarts; the encoder reconnects.
- Two AZs give two ingest IPs; either works (`SrtIngestIp1`, `SrtIngestIp2` outputs).
- The venue allowlist sits on the NLB security group, in front of the task.
- With `inputSource=rtmps`, Caddy forwards RTMP to a TCP listener on the same NLB (record 6).

**Cost.** The NLB-hour and its two Elastic IPs are about $0.034 per hour ($0.0243 + 2 x $0.005, [cost.md](cost.md#every-billed-resource));
with the assumed 1 LCU per hour the table counts $0.030 for the NLB plus $0.010 for the addresses.

**Alternatives.**

| Alternative | Why not |
|---|---|
| The task's own public IP | Changes on every restart and deploy; the venue would have to re-allow it each time. |
| An Elastic IP on an EC2 host running the app | Needs a patched host and a restart script; see record 1. |
| Global Accelerator or a second proxy | Not evaluated; it adds a service for a problem the NLB already solves. |

**Public subnets without NAT.** The stack uses two public subnets and no NAT gateway (`natGateways: 0`). Security groups
are the boundary ([security.md](security.md#what-is-public)). This avoids NAT hourly and per-GB charges and lets the task
call AWS APIs directly. The task has a public IPv4 address for egress only. The consequence: if your organisation turns on
[VPC Block Public Access](https://docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html), traffic through the
internet gateway is blocked unless the VPC or subnets have an exclusion. The stack needs the `allow-bidirectional`
mode on its public subnets, because the venue and browsers connect inbound
([exclusion modes](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VpcBlockPublicAccessExclusion.html)).
After `cdk destroy` and a new deploy the subnets are new, so exclusions that named the old subnets no longer apply and
need to be created again (an exclusion on the whole VPC has the same issue, since the VPC is new). The repo does not
create exclusions and this behavior has not been tested here; it follows from the AWS documentation.

**Consequences.** About $0.034 per hour for an address that stays put. One more thing to destroy: the NLB cannot be
paused, only deleted ([cost.md](cost.md#how-to-stop-paying)).

Detail: [security.md](security.md#what-is-public), [cost.md](cost.md), [operations.md](operations.md).

## 3. Bedrock for translation, Amazon Translate as the backup

**Context.** Speech arrives in chunks of a few words. A chunk cut mid-sentence is hard to translate on its own.
Product names need fixed translations.

**Decision.** The default engine is Claude Haiku 4.5 on Amazon Bedrock (`translateEngine=llm`, part of the `talk`
profile). Amazon Translate stays as backup and as an opt-in low-cost engine.

| | Bedrock (Claude Haiku 4.5) | Amazon Translate |
|---|---|---|
| Context | Sends the previous chunks (`llmContextChunks`, default 3) and whether the chunk ended a sentence. | `TranslateText` per chunk, no context. |
| Glossary | Terminology loaded from the same Translate terminology at startup and put in the prompt. | Applies the terminology itself. |
| Quality | About 4.1 of 5 against 3.0 on a judged sample of 56 chunks (AI judges, not native listeners; [configuration.md](configuration.md#profiles)). | Lower in that sample. |
| Latency | About 0.5 s per chunk in the [latency budget](architecture.md#latency-budget). | About 0.6 s per chunk faster in the same setup. |
| Cost | About $0.93 per hour. | About $0.48 per hour. Default session: about +$0.46 per hour for Bedrock, about $9.7 against $7.8 for 4 hours ([cost.md](cost.md#sensitivity)). |
| Prerequisites | Model access in the Region, first-use form for Anthropic models, a geo inference profile. | None beyond IAM. |

**Bedrock prerequisites.** The Converse call needs an inference profile (the bare model id is not supported). With
`llmModelId=auto` the stack picks the geo profile (`jp.`, `us.`, `eu.`, `au.`, `in.`) that the stack Region can call and
limits IAM to that profile and its destination Regions ([configuration.md](configuration.md#llm-model-id)). A Region
without a profile fails at synth with advice. `./scripts/doctor.sh` checks the profile read-only
([operations.md](operations.md#bedrock-access-the-default-engine)). Requests are processed in the profile's destination Regions.

**Why Translate stays** ([configuration.md](configuration.md#amazon-translate-is-the-backup-translator)):

1. Fallback when the circuit breaker is open, a call fails or times out (`llmTimeoutMs`, default 1200 ms), the output is
   rejected by validation, or `llmSkipBacklogMs` skips the LLM because playback is behind. Speech never stops.
2. The Translate custom terminology is the one store of terms that the LLM glossary reads, so one `terms.csv` serves both engines
   ([dictionaries.md](dictionaries.md)).
3. `-c translateEngine=translate` is the low-cost mode (about $2.0 instead of $2.4 per hour) and works without Bedrock access.

**Alternatives.** Translate only: cheaper, no context ([cost.md](cost.md)). A larger model: not evaluated here.

**Consequences.** Quality dips on fallback, visible in the logs (`LLM_FALLBACK`, `[llm] BREAKER`). Cost grows with the number
of chunks and not their length, because each call re-reads the cached glossary (about 5,500 tokens), and a keep-warm call
every four minutes keeps the prompt cache alive (`llmKeepWarmMs`).

Detail: [configuration.md](configuration.md#profiles), [cost.md](cost.md#sensitivity), [bilingual-channels.md](bilingual-channels.md).

## 4. LiveKit as the media server

**Context.** The app has to publish a synthesized audio track to many phones with low delay, plus captions, and the audio
comes from a server process, not from a browser.

**Decision.** LiveKit, self-hosted on one EC2 instance. The app joins a room as `publisher-app` using the LiveKit server SDK
(`@livekit/rtc-node`); listeners get subscribe-only tokens. Captions travel as reliable data packets on topic `captions` in the
same room, so there is no second connection ([architecture.md](architecture.md#transport)). With `inputSource=browser`
the speaker's microphone goes to a separate ingest room (`<roomName>-ingest`) that the app subscribes to, so listeners cannot
reach it ([alternative-inputs.md](alternative-inputs.md#browser-microphone-path)).

**Alternatives.**

| Alternative | Status | Reason |
|---|---|---|
| Amazon IVS Real-Time | Evaluated | Accepts WHIP publishing but requires an H.264 video track, even for audio only ([architecture.md](architecture.md#design-choices)). |
| Amazon Chime SDK | Evaluated | No clean way to publish audio from a headless server ([architecture.md](architecture.md#design-choices)). |
| HLS or LL-HLS | Not evaluated in depth | Chunked HTTP delivery adds segment buffering by design; the project aims for a few seconds end to end. |
| WebSocket audio stream | Not evaluated in depth | The page would need its own jitter buffer, decoder and playback code, and TCP gives no loss tolerance. WebRTC has these in the browser. |

**Consequences.** Open source (Apache-2.0 per [architecture.md](architecture.md#design-choices)). You run the server (record 1).
Browsers need UDP to the host or fall back to TCP 7881. The caption packets reach only listeners who pressed **Listen**,
and cost about 370 bytes per second per listener ([cost.md](cost.md)).

Detail: [architecture.md](architecture.md#design-choices), [alternative-inputs.md](alternative-inputs.md).

## 5. Synchronous calls and streams per hop

**Context.** Some hops carry a continuous signal, others one request per chunk of text.

**Decision.** Stream where the data is continuous. Use one synchronous request per chunk where the next stage needs the
whole result.

| Hop | Style | Notes |
|---|---|---|
| Venue to app: SRT | Stream (UDP) | ffmpeg is the SRT listener in the app and writes 16 kHz PCM (`srt-source.ts`). |
| App to Transcribe | Bidirectional stream, partial results | `StartStreamTranscription` ([AWS docs](https://docs.aws.amazon.com/transcribe/latest/dg/streaming.html)); the app sends 100 ms frames and reads partial results. |
| Translate | Synchronous per chunk | `TranslateText` (`translate-call.ts`). |
| Bedrock | Synchronous per chunk, not streamed | One `Converse` call with a hard timeout (`bedrock-llm.ts`). IAM grants `bedrock:InvokeModel` only; `InvokeModelWithResponseStream` is not granted and `ConverseStream` is not used (comment in the stack). Polly needs the whole chunk, and the output is validated before it is spoken, so streaming tokens would not start speech earlier. |
| Polly | Synchronous per chunk | `SynthesizeSpeech` with PCM output. The response body is an async iterable that the app reads to the end and joins into one buffer (`chunk-player.ts`), because the speed level is chosen per chunk before the audio is pushed. |
| App to listeners: audio | Stream (WebRTC, Opus) | Published to LiveKit; played by the browser. |
| App to listeners: captions | Asynchronous messages | Reliable data packets; sending never blocks the pipeline (`caption-publisher.ts`). |
| Token | Synchronous | Browser to CloudFront to Lambda function URL. |
| CloudWatch Logs | Asynchronous | ECS `awslogs` driver (app) and Docker `awslogs` driver (LiveKit, Caddy). |
| Bedrock keep-warm | Background timer | A dummy call before the 5-minute prompt cache expires (`keepWarmTick`). |

**How it stays fast with synchronous calls.** The first stages stream, so work starts before a sentence ends. The
segmenter cuts speech into chunks of a few words (about 1,130 chunks per hour with the `talk` profile), so each
synchronous call is short. The chunk player takes one chunk at a time in order. When the backlog grows, Polly speaks
faster in graded levels, and chunks older than `maxBacklogMs` (15 s by default) are dropped. With two channels, each lane
has its own player, so the two directions do not queue behind each other ([bilingual-channels.md](bilingual-channels.md)).
Where the time goes (about 6 s to the first translated word, most of it waiting for words and Transcribe stabilization) is
in the [latency budget](architecture.md#latency-budget).

**Alternatives.** Streaming Bedrock output into Polly: not adopted for the reason in the table. Batching whole sentences:
available as `segmentationMode=sentence`, with higher delay ([configuration.md](configuration.md)).

**Consequences.** Every synchronous call has a timeout and a failure path (Translate fallback, SSML to plain text retry).
Per-chunk calls make cost scale with chunk count.

Detail: [architecture.md](architecture.md#data-flow), [configuration.md](configuration.md).

## 6. Where TLS and encryption end

| Hop | Protection | Ends at | Source |
|---|---|---|---|
| Listener page and `/token` | HTTPS (CloudFront redirects HTTP). Lambda function URL uses `AWS_IAM`, called only by CloudFront through origin access control. | CloudFront | `simul-translation-stack.ts` |
| Browser to LiveKit signaling | `wss://<IP>.sslip.io`, Let's Encrypt certificate | Caddy on the EC2 host; Caddy proxies plain HTTP to LiveKit on `127.0.0.1:7880` on the same host | `livekit-user-data.ts` |
| Audio and captions to browsers | WebRTC DTLS-SRTP for audio; data packets use DTLS ([RFC 8827](https://www.rfc-editor.org/rfc/rfc8827), WebRTC security architecture) | The browser | WebRTC standard |
| Venue SRT | SRT AES encryption with the passphrase (`pbkeylen=16`), not TLS | ffmpeg inside the app task. The NLB passes UDP through. | `srt-source.ts`, stack output |
| RTMPS (optional) | TLS | Caddy layer4 route chosen by SNI and venue source address. Then plain RTMP over the NLB TCP listener, allowed from the LiveKit Elastic IP only. | [alternative-inputs.md](alternative-inputs.md#rtmps-path) |
| Browser microphone (optional) | `wss` to the ingest room, DTLS-SRTP for audio | LiveKit. The app subscribes to the ingest room over `wss` through Caddy. | [security.md](security.md#browser-microphone-input) |
| App to AWS APIs | HTTPS (AWS SDK) | The AWS service | app code |
| App to LiveKit | `wss://` through Caddy (`LIVEKIT_URL` is `wss://<host>`) | Caddy | stack |

**Residual risk.** In the RTMPS input, the decrypted stream, including the stream key, crosses the AWS network
between the LiveKit instance and the NLB's public address as plain RTMP. Only the LiveKit Elastic IP may connect
to that port. Accepting this avoided a second, internal load balancer ([security.md](security.md#residual-risks)).

**Alternatives.** Your own domain and certificate: supported (`livekitHostname`), not required. Port 80 validation
(HTTP-01): not used, so port 80 stays closed. A VPN or private link for the venue: not evaluated.

Detail: [security.md](security.md), [alternative-inputs.md](alternative-inputs.md).

## 7. Decisions documented elsewhere

| Decision | Why | Where |
|---|---|---|
| SRT from OBS is the default input. Browser microphone and RTMPS are optional, one input per deploy. | SRT survives packet loss and has a passphrase; the others cover venues without an audio line out or without outbound UDP. | [alternative-inputs.md](alternative-inputs.md), [architecture.md](architecture.md#design-choices) |
| One Transcribe stream with language identification, and a language filter. | Rooms with questions in another language would be transcribed into nonsense; the app drops results not in the source language. | [architecture.md](architecture.md#design-choices) |
| Two channels from one stream. | Each direction is a lane with its own translation, voice and LiveKit track; Transcribe cost does not double. | [bilingual-channels.md](bilingual-channels.md), [cost.md](cost.md#two-channels) |
| Dictionaries come from one `terms.csv`. | A command generates the Transcribe vocabulary, the Translate terminology and the Polly readings, so they cannot drift apart. | [dictionaries.md](dictionaries.md) |
| One deployable CDK stack with profiles and validation. | Settings resolve in a fixed order (flag, `event.json`, profile, `cdk.json`) and invalid values fail at synth. | [configuration.md](configuration.md) |
