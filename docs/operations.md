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
The two Secrets Manager secrets are deleted, but Secrets Manager may keep them for a recovery period.

`cdk destroy` does **not** remove what `dictionaries.sh` and the bootstrap created. Delete these by hand if you do not need them:

```bash
aws transcribe delete-vocabulary --vocabulary-name simul-translation --region ap-northeast-1
aws translate delete-terminology --name simul-translation --region ap-northeast-1
aws s3 rb s3://simul-translation-dict-<account-id>-ap-northeast-1 --force
```

The CDK bootstrap stack `CDKToolkit` (and its asset bucket and image repository) stays. Other projects may use it.

## Do not rename

The stack id `SimulTranslation`, the log groups `/simul-translation/...` and the secret and resource names are
kept even though the repository has a different name. Renaming the stack id would replace the whole stack and change
every address. `E2E_STACK` and `STACK_NAME` default to this id.
