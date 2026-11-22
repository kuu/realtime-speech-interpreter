# Operations: event-day runbook

Commands run from the repository root unless a `cd` is shown. Replace `ap-northeast-1` if you changed the Region.

## Before the event (days before)

1. Deploy and publish dictionaries (see the README Quick start). Run `./scripts/doctor.sh` and fix every FAIL.
2. Ask the venue for the **public** IP address that their network uses to reach the internet, and whether UDP
   leaves the network. Test it from the venue network, not from your hotel: `curl https://checkip.amazonaws.com`.
3. Put the address in `cdk/config/event.json` (`venueCidr`, a list is fine) and deploy:
   ```bash
   cd cdk && npx cdk deploy
   ```
   This is what opens the SRT port. SRT uses UDP, so a blocked sender gets **no error**. OBS only shows
   "reconnecting".
4. Rehearse with the real encoder and network (below).

## Event day

1. **Check the system** (read-only):
   ```bash
   ./e2e/e2e.sh check
   ```
   It must say `READY`. It also tells you whether this machine's IP is allowed on the SRT port and whether another SRT
   sender is connected. If something is stopped, `./e2e/e2e.sh check --fix` shows each repair and asks first.
2. **Get the SRT URL and passphrase** from the stack outputs:
   ```bash
   aws cloudformation describe-stacks --stack-name SimulTranslation --region ap-northeast-1 \
     --query "Stacks[0].Outputs[?OutputKey=='ObsSrtUrlTemplate'||OutputKey=='GetSrtPassphraseCommand'||OutputKey=='ListenerUrl'].[OutputKey,OutputValue]" --output text
   ```
   Run the `GetSrtPassphraseCommand` value and put the passphrase in place of `<SRT_PASSPHRASE>`. Do not paste it into chat or
   tickets.
3. **Rehearsal** (30 minutes before): start the encoder, open the `ListenerUrl` on a phone, press Listen, speak
   English for two minutes, and check that you hear Japanese and that the first word arrives in about 6 seconds.
4. **Go live.** Only one SRT sender can be connected at a time. Stop any test encoder first.
5. **Watch the logs** (see below). After the session, check the `[summary]` line.

## Two channels (only with `channels` in `event.json`)
- **One QR code per channel.** The stack prints `ListenerUrl` (the first channel in `channels`, the default) and `ListenerUrlEn`
  (`?ch=en`) for the second one. Print both; a listener who opens an unknown `?ch=` sees "This channel is not available".
- **Silence is normal.** Each channel is quiet while the other language is spoken. A listener who joins during a pause hears
  nothing from channel 2 until Japanese is spoken.
- **Lane 2 failure.** If channel 2 cannot start the log shows `lane en disabled: <reason>` and channel 1 serves as usual; the
  health body shows it. The listener page for channel 2 shows "Channel not live yet" and stays quiet. Run `./scripts/doctor.sh`
  (it checks the Japanese vocabulary, the `<name>-ja-en` terminology and the English voice) and restart the task.
- **Dictionaries.** After editing `terms.csv`, run `node dictionaries/build.mjs generate` and `cd cdk && ./scripts/dictionaries.sh`;
  it also uploads `<name>-ja` and `<name>-ja-en` when they exist. Set both names on the Japanese channel in `event.json`.

## Browser microphone input (only with `-c inputSource=browser`)

The stack is closed until you run the operator command. Before the event, and again to rotate the code:

```bash
node cdk/scripts/publisher-code.mjs --ends-at 2026-11-06T09:00:00Z
```

`--ends-at` is the event end time in UTC (`Z` suffix, in the future). The command prints the speaker URL
(`https://<site>/publish`) and the event code once. Send both to speakers in Slack. Speakers paste the code on their
laptop screen only, never on the projector-mirrored screen. Run the command again to rotate the code (an old code is
rejected on the next request). A connected publisher stays unless you add `--disconnect`. `--dry-run` checks the
arguments and calls nothing. The code is not stored in a file or log; the secret in Secrets Manager holds it.

The operator's identity needs `cloudformation:DescribeStacks`, `secretsmanager:PutSecretValue` on the code secret,
`ssm:PutParameter` on `/simul-translation/publisher-not-after`, and for `--disconnect` `secretsmanager:GetSecretValue`
on the LiveKit secret. Switching `inputSource` between `srt` and `browser` is a deploy (2 to 3 minutes).

Watch the log with `aws logs tail /simul-translation/app --follow --filter-pattern "[ingest]" --region ap-northeast-1`.
The lines (`publisher joined`, `publisher replaced`, `no publisher for Ns`, `silent Ns`, `level`) are listed in
[security.md](security.md#browser-microphone-input). The speaker checklist is in the same section.

## RTMPS input (only with `-c inputSource=rtmps`)

Use it when the venue network blocks outbound UDP (SRT cannot get out). Design: [alternative-inputs.md](alternative-inputs.md).

1. Deploy with the flag (and the venue IP as always): `cd cdk && npx cdk deploy -c inputSource=rtmps`. Docker must be
   running: the deploy builds the custom Caddy image (`cdk/caddy-l4`, several minutes the first time). If
   `proxy.golang.org` is unreachable from your machine, set `CADDY_GOPROXY` first (see
   [cdk/caddy-l4/README.md](../cdk/caddy-l4/README.md)); `./scripts/doctor.sh -c inputSource=rtmps` checks it. The LiveKit
   instance is replaced by this deploy (short outage, the Elastic IP stays); Caddy then needs 1 to 3 minutes for the
   certificate of the new `rtmps.` name.
2. Get the URL and the stream key:
   ```bash
   aws cloudformation describe-stacks --stack-name SimulTranslation --region ap-northeast-1 \
     --query "Stacks[0].Outputs[?OutputKey=='RtmpsUrl'||OutputKey=='GetRtmpsStreamKeyCommand'].[OutputKey,OutputValue]" --output text
   ```
   Run the `GetRtmpsStreamKeyCommand` value to print the key. Treat it like a password.
3. OBS: Settings > Stream > Service **Custom...**, Server = the `RtmpsUrl` value
   (`rtmps://rtmps.<LiveKit IP>.sslip.io:443/live`), Stream Key = the key. **Do not replace the name with the IP
   address**: the name selects the RTMPS route, a bare IP fails. Settings > Output: audio AAC, 128 kbps, 48 kHz, mono or
   stereo. OBS sends a video track with RTMP; keep it minimal (for example a small static image, low bitrate); the app
   ignores video. Enable Settings > Advanced > Automatically reconnect. ffmpeg:
   ```bash
   ffmpeg -re -i input.wav -vn -ac 1 -ar 48000 -c:a aac -b:a 128k -f flv \
     "rtmps://rtmps.<LiveKit IP>.sslip.io:443/live/<stream key>"
   ```
4. Only the venue IPs in `venueCidr` can connect; from elsewhere the connection is closed before TLS (OBS shows a
   connection error). Changing `venueCidr` with `inputSource=rtmps` replaces the LiveKit instance, so set it days
   before the event.
5. Log lines (`aws logs tail /simul-translation/app --follow --filter-pattern "[rtmp]" --region ap-northeast-1`):
   `[rtmp] listening on port 1935`, `[rtmp] publish accepted`, `[rtmp] stream ended`, and
   `[rtmp] rejected publish with a wrong key` (check the key in OBS). Caddy logs are in the `/simul-translation/livekit`
   log group, stream `caddy`.
6. Switch back to SRT with a deploy without the flag (or `-c inputSource=srt`). It removes the RTMPS listener and
   secret and replaces the LiveKit instance with the official Caddy image again.
7. Rebuild duty: when Caddy, caddy-l4 or Go publish a security fix, update the pins in `cdk/caddy-l4/Dockerfile` and
   deploy ([cdk/caddy-l4/README.md](../cdk/caddy-l4/README.md)).

## Encoder settings (OBS)

Output: custom, FFmpeg output to the SRT URL, container `mpegts`, audio codec `libopus`, mono or stereo, 48 kHz,
128 kbps. The URL uses `mode=caller`. No video track is needed. `ffmpeg` works the same way:

```bash
ffmpeg -re -i input.wav -vn -ac 1 -ar 48000 -c:a libopus -b:a 128k -f mpegts \
  "srt://<SrtIngestIp1>:9000?mode=caller&latency=120000&pbkeylen=16&passphrase=<SRT_PASSPHRASE>"
```

## Monitoring: log lines to look for

Log group `/simul-translation/app` (in the CloudWatch console, or `aws logs tail /simul-translation/app --follow --region ap-northeast-1`).
Add `--filter-pattern` with one of these:

| Pattern | Meaning | Action |
|---|---|---|
| `[srt] listening` | The app waits for the encoder. | Normal at start. |
| `startBurstMs=` | First audio of a stream arrived. Expect below 1000. | If large, check the encoder and network. |
| `[livekit] connected` | The app can publish to LiveKit. | Missing: LiveKit host is down, see below. |
| `PLAYED` | A chunk was spoken. Has `e2eFirstWordMs=`. | Typical 5000 to 7000 with the `talk` profile. |
| `DROPPED reason=backlog` | The listener was too far behind, a chunk was skipped. | Slow speaker handling? See [configuration](configuration.md) (`maxBacklogMs`). |
| `FAILED` | A stage failed (`stage=translate`, `synth`, `play`). | One is fine. Many: check IAM, quotas, Region. |
| `LLM_FALLBACK`, `[llm] BREAKER` | The LLM engine fell back to Amazon Translate. | Quality dips, audio continues. Check Bedrock access and throttling. |
| `[langfilter] dropped` | Japanese or non-English speech was dropped on purpose. | Many drops while only English is spoken: language filter problem. |
| `[srt] stream ended` | The encoder disconnected. | Restart the encoder. |
| `[summary]`, `[llm-summary]` | Totals at the end of a session. | Keep for the report. |
| `lane en disabled` | Two-lane deploy: lane 2 could not start (LiveKit connect, engine, or the 20 s start-up deadline). Lane 1 keeps running; the health endpoint answers `ok lanes=ja:up,en:disabled`. | Run `./scripts/doctor.sh`, fix the named cause, restart the task. |
| `ch=en`, `ch=ja` | Two-lane deploy: every per-lane line (`[chunk N ch=en]`, `[langfilter] ch=en`, `[captions] ch=en`, `[summary] ch=en`) names its channel. | Filter on `ch=en` to read one channel. |
| `lateSpoken=` | In `[langfilter] ch=... stream=...`: late language flips after text was already emitted. | A few per hour is normal in mixed Q&A; many: the settle thresholds are too low (configuration, `langidSettleItems*`). |
| `captions=on` | Startup line: captions are on (`topic=captions schema=1`). | `captions=off`: the deploy setting is off. |
| `[captions]` | Caption totals per session: `caption=` Japanese lines sent (equals `played`), `source=` English packets, `retracted=` English results withdrawn after a late language flip, `failed=` packets LiveKit refused, `sourceLagMs(avg/max)=` time from the end of the words to their packet. | `failed` above 0 or `caption=0` while `played` grows: check `[livekit] connected` and the LiveKit host. |

The LiveKit host logs to `/simul-translation/livekit`, the token function to `/simul-translation/token`.

## If something breaks

| Symptom | First step |
|---|---|
| Encoder cannot connect | `./e2e/e2e.sh check` (is this IP allowed? is another sender connected?). Check the venue IP, then `cdk deploy`. |
| Connected, no Japanese | `grep` the app log for `[livekit] connected`, `PLAYED`, `FAILED`. Then see Troubleshooting in the README. |
| Listener page loads but "not connected" | LiveKit instance stopped or TLS not ready. `./e2e/e2e.sh check --fix` starts it. |
| App task crashed | The ECS service restarts it. If it loops, `check` prints the stop reason and the last log lines. |
| Need a fresh task | `aws ecs update-service --cluster <EcsClusterName> --service <EcsServiceName> --force-new-deployment`. Expect 1 to 3 minutes without service. |

A manually added security group rule is removed by the next `cdk deploy` unless the IP is also in `venueCidr`.

## Scale down after the event

The stack costs money while it exists, even when idle (about $4.9 per day as deployed, see [cost](cost.md)). For a break of days:

```bash
# stop the app task
aws ecs update-service --cluster <EcsClusterName> --service <EcsServiceName> --desired-count 0 --region ap-northeast-1
# stop the LiveKit host (the Elastic IP stays)
aws ec2 stop-instances --instance-ids <LiveKitInstanceId> --region ap-northeast-1
```

The names are stack outputs. `./e2e/e2e.sh check --fix` brings both back. The Network Load Balancer, Elastic IPs and the
CloudFront distribution keep running and are billed. For anything longer, tear the stack down.

## Tear down

```bash
cd cdk
npx cdk destroy
```

This removes the stack and its resources: VPC, Network Load Balancer, Fargate service, EC2 host, Elastic IPs,
CloudFront distribution, the site bucket (emptied automatically), the Lambda function and the CloudWatch log groups.
The two Secrets Manager secrets (three with browser input) are deleted, but Secrets Manager may keep them for a recovery period.

`cdk destroy` does **not** remove what `dictionaries.sh` and the bootstrap created. Delete these by hand if you do not need them:

```bash
aws transcribe delete-vocabulary --vocabulary-name simul-translation --region ap-northeast-1
aws translate delete-terminology --name simul-translation --region ap-northeast-1
aws s3 rb s3://simul-translation-dict-<account-id>-ap-northeast-1 --force
```

With browser input, the SSM parameter `/simul-translation/publisher-not-after` was created by the operator command, not
by CDK, so `cdk destroy` leaves it. Delete it by hand: `aws ssm delete-parameter --name /simul-translation/publisher-not-after --region ap-northeast-1`.
The CDK bootstrap stack `CDKToolkit` (and its asset bucket and image repository) stays. Other projects may use it.

## Do not rename

The stack id `SimulTranslation`, the log groups `/simul-translation/...` and the secret and resource names are
kept even though the repository has a different name. Renaming the stack id would replace the whole stack and change
every address. `E2E_STACK` and `STACK_NAME` default to this id.
