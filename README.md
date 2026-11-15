# Realtime Speech Interpreter

Real-time speech-to-speech interpretation on AWS, English to Japanese first. A speaker talks English at an event.
Attendees open a web page on their phones and hear Japanese about 6 seconds later. The audio goes from OBS over SRT
to an app on AWS Fargate. The app uses Amazon Transcribe to get text, Amazon Translate or an Amazon Bedrock model
to translate it, and Amazon Polly to speak it. A self-hosted LiveKit server delivers the audio to the browsers.

This is a personal, unofficial open-source project. It is not an AWS product, it is not affiliated with, endorsed or
supported by Amazon Web Services, and AWS Support will not help with it. AWS, Amazon Transcribe, Amazon Translate,
Amazon Polly, Amazon Bedrock and AWS Fargate are trademarks of Amazon.com, Inc. or its affiliates.

![Architecture: venue, SRT, Fargate app, Transcribe, Translate or Bedrock, Polly, LiveKit, listener browsers](docs/architecture.svg)

Details of the diagram: [docs/architecture.md](docs/architecture.md).

## What works today

| Use case | Status | Notes |
|---|---|---|
| One speaker, English to Japanese (talk, keynote) | **Supported** | The case this project was built and tested for. |
| Japanese speech in the room is ignored | **Supported** | A language filter drops it, so a moderator or a question is not translated. |
| Custom dictionaries and pronunciations | **Supported** | Edit files, run a script. See [docs/dictionaries.md](docs/dictionaries.md). |
| Round table or fireside chat, several speakers | **Planned** | Needs speaker detection and a different voice per speaker. |
| Q&A in two directions with two channels | **Planned** | Channel 1: English to Japanese. Channel 2: Japanese to English, from the same audio. |
| Captions shown with the audio | **Planned** | The text already exists in the pipeline. It is not sent to the page yet. |
| Browser microphone as input (`getUserMedia`) | **Planned** | For venues with no audio line out, or no PC to run OBS. |
| Dictionary builder (easier than editing files) | **Idea** | A tool that suggests terms from slides or a transcript. |
| Voice that follows the speaker | **Idea** | Depends on speaker detection. |

## Quick start (about 10 minutes plus deploy time)

You need an AWS account where you may create VPCs, ECS, EC2, CloudFront, Lambda, S3 and IAM resources. Running the
stack costs money, see [Costs](#costs).

**Prerequisites**

| Tool | Version | Check |
|---|---|---|
| Git | any | `git --version` |
| Node.js and npm | Node 20 or newer (22 recommended), npm 9 or newer | `node --version` |
| AWS CLI | v2 | `aws --version` |
| Docker | running daemon (builds the app image) | `docker info` |
| ffmpeg with SRT and Opus | for the encoder test and the e2e harness | `ffmpeg -protocols 2>/dev/null \| grep srt` |

On macOS, `brew install ffmpeg-full` includes SRT. The plain `ffmpeg` formula does not.
Use AWS credentials for the target account (`aws sts get-caller-identity` must work).

**1. Clone and install**

```bash
git clone https://github.com/kuu/realtime-speech-interpreter.git
cd realtime-speech-interpreter
(cd app && npm ci)
(cd cdk && npm ci)
```

**2. Describe your event**

```bash
cp cdk/config/event.example.json cdk/config/event.json
```

Edit `cdk/config/event.json`. At least set `venueCidr` to the public IP address of the venue network (find it from
the venue network with `curl https://checkip.amazonaws.com`, then add `/32`). Every setting is explained in
[docs/configuration.md](docs/configuration.md). `event.json` is git-ignored.

**3. Check your machine and account** (read-only)

```bash
./scripts/doctor.sh
```

Fix every `FAIL` line. Each one prints the command that fixes it.

**4. Bootstrap CDK** (once per account and Region)

```bash
cd cdk && npx cdk bootstrap && cd ..
```

**5. Publish the dictionaries**

```bash
node dictionaries/validate.mjs
(cd cdk && ./scripts/dictionaries.sh)
```

This creates a Transcribe custom vocabulary and a Translate terminology named `simul-translation`, from the example
files in `dictionaries/`. Replace them with your own terms later.

**6. Deploy**

```bash
cd cdk && npx cdk deploy && cd ..
```

It builds the app image and takes several minutes. The outputs include `ListenerUrl` and the SRT address.
Without Bedrock access, set `"translateEngine": "translate"` in `event.json` first.

**7. Test with a sample, without OBS**

```bash
./samples/make-samples.sh talk-single      # makes samples/out/talk-single.wav with Polly (a few cents)
./e2e/e2e.sh check
./e2e/e2e.sh local samples/out/talk-single.wav --duration 1m --label first-try
```

`check` must say `READY`. `local` runs the app on your machine against a short English clip and writes the Japanese
audio to `e2e/runs/`. Open the folder and play `side-by-side.wav` (left: English, right: Japanese).
See [docs/e2e-testing.md](docs/e2e-testing.md).

**8. Send audio by SRT and listen**

Get the SRT URL and passphrase from the stack outputs (commands in [docs/operations.md](docs/operations.md)), then
send a file with ffmpeg, or point OBS at the same URL:

```bash
ffmpeg -re -i path/to/english-speech.wav -vn -ac 1 -ar 48000 -c:a libopus -b:a 128k -f mpegts \
  "srt://<SrtIngestIp1>:9000?mode=caller&latency=120000&pbkeylen=16&passphrase=<SRT_PASSPHRASE>"
```

Open the `ListenerUrl` on a phone, press **Listen**, and put on headphones. Run this command from the network that
you put in `venueCidr`.

## Costs

Prices as of 2026-11-15, region ap-northeast-1, USD, list price, tax excluded.

| Case | Cost |
|---|---|
| Running session, 100 listeners, LLM engine (default `talk` profile) | about **$2.4 per hour** |
| Same with the Amazon Translate engine | about $2.0 per hour |
| Stack left deployed with nobody speaking | about **$4.9 per day** (about $0.20 per hour) |
| ECS desired count 0 / also LiveKit instance stopped | about $3.6 / $1.0 per day |
| After `cdk destroy` | about $0.003 per day |

The speech services (Transcribe, Bedrock or Translate, Polly) are 75-80% of a running hour. The Network Load Balancer,
the EC2 host, the Fargate task and the Elastic IPs bill whether or not anyone is listening. Set the ECS desired count
to 0, stop the LiveKit instance, or run `cdk destroy` when you are done. The figures are estimates from one measured
cloud run and list prices. See [docs/cost.md](docs/cost.md) for every billed resource, what is measured and what is
assumed, the listener-count sensitivity and the calculator (`node scripts/estimate-cost.mjs --hours 4 --listeners 100`).

## Customize

| What | How | Needs |
|---|---|---|
| Terms the speech recognizer gets wrong | Edit `dictionaries/transcribe-vocabulary.txt`. | `dictionaries.sh` |
| Translation of a term | Edit `dictionaries/translate-terminology.csv`. | `dictionaries.sh` |
| Polly pronunciation of a name | Edit `app/assets/polly-readings.csv`. The displayed text never changes. | `cdk deploy` |
| Wrong word that is valid English (ABC for AVC) | Add a rule in `app/src/corrections.ts`. | `cdk deploy` |
| Voice | `"pollyVoice"` in `event.json`. | `cdk deploy` |
| Speed of the first word vs. quality | `"profile"` in `event.json`: `talk` (fast, LLM), `careful` (longer chunks, Translate). | `cdk deploy` |
| Translation engine and model | `"translateEngine"` and `"llmModelId"` in `event.json`. | `cdk deploy` |
| Expected number of listeners | `"expectedListeners"`. Sets the LiveKit instance size (an estimate). | `cdk deploy` |

Run `node dictionaries/validate.mjs` after dictionary edits. See [docs/dictionaries.md](docs/dictionaries.md) and
[docs/configuration.md](docs/configuration.md).

## Event-day checklist

- [ ] Venue public IP is in `venueCidr` and deployed. Test it from the venue network.
- [ ] `./e2e/e2e.sh check` says `READY`.
- [ ] Dictionaries are published and match the talk.
- [ ] SRT URL and passphrase are on the encoder machine (not in chat).
- [ ] Rehearsal done with the real encoder and network. You heard Japanese on a phone.
- [ ] Only one encoder is connected.
- [ ] The listener URL is on the slides or a QR code, with the machine-translation notice.
- [ ] Someone watches the logs. Log lines to look for are in [docs/operations.md](docs/operations.md).
- [ ] After the event: scale down or `cdk destroy`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| OBS or ffmpeg keeps "connecting" and nothing is logged | **The venue IP is not allowed.** SRT is UDP, so a blocked sender gets no error. Check the public IP from the venue network, put it in `venueCidr`, run `cdk deploy`. `./e2e/e2e.sh check` tells you whether this machine is allowed. A phone hotspot has another IP. |
| Second encoder cannot connect | **Only one SRT sender at a time.** Stop the first one (a test encoder, a second OBS). |
| Connected, but listeners hear nothing | Tap **Listen** again (browsers need a tap). Run `./e2e/e2e.sh check`. Look in `/simul-translation/app` for `[livekit] connected` and `PLAYED`. Check that the speech really is English: Japanese speech is dropped on purpose. |
| Polly says a product name wrongly | Add a reading in `app/assets/polly-readings.csv`, validate, `cdk deploy`. Do not change the name in the text. See [docs/dictionaries.md](docs/dictionaries.md). |
| A term is heard as another word | Add it to the vocabulary. If it is still wrong (for example ABC for AVC), add a context correction. |
| Bedrock "access denied" or "model not found" | Open the Bedrock console in your Region and check that the model in `llmModelId` is available to your account (first use of some models asks for a use-case form). `./scripts/doctor.sh` checks the profile. Or use `"translateEngine": "translate"`. |
| `doctor` says CDK is not bootstrapped | Run step 4. |
| Page loads, status says not connected | The LiveKit instance is stopped or still starting. `./e2e/e2e.sh check --fix`. |

## Security and privacy

- The listener page and the token endpoint are public. Tokens only allow listening, and expire after 6 hours.
- SRT is accepted from your venue IP only, and needs a passphrase.
- Secrets are in AWS Secrets Manager. IAM roles are limited to the calls the app makes.
- Audio is not recorded. The text of every chunk is written to CloudWatch Logs (14 days by default).
- Speech and text go to Amazon Transcribe, Translate or Bedrock, and Polly. Tell speakers and attendees.
- The translation is machine-made. Show a notice on the listener page.

Details and a suggested notice: [docs/security.md](docs/security.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Documentation

| Page | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, data flow, latency budget, design choices |
| [docs/configuration.md](docs/configuration.md) | All settings |
| [docs/dictionaries.md](docs/dictionaries.md) | Vocabulary, terminology, readings, corrections |
| [docs/operations.md](docs/operations.md) | Event-day runbook, monitoring, tear down |
| [docs/security.md](docs/security.md) | Exposure, secrets, IAM, privacy, consent |
| [docs/cost.md](docs/cost.md) | Billed resources, cost per hour, idle cost, how to stop paying |
| [docs/e2e-testing.md](docs/e2e-testing.md) | Test harness and metrics |
| [docs/roadmap.md](docs/roadmap.md) | Planned features, written as issues |

## Roadmap

1. Subtitles on the listener page.
2. Two channels from one audio source (English to Japanese, Japanese to English).
3. Speaker detection and one voice per speaker.
4. Browser microphone input (`getUserMedia`).
5. Dictionary builder.

Details and acceptance criteria: [docs/roadmap.md](docs/roadmap.md). The order can change. Ideas and use cases are welcome as issues.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Before you open a pull request:

```bash
(cd app && npm run build && npm test)
(cd cdk && npm test)
node dictionaries/validate.mjs
node --test scripts/render-architecture.test.mjs
./scripts/check-publishable.sh
```

If you change the diagram, edit `docs/architecture.model.json` and run `node scripts/render-architecture.mjs`.
Do not commit account IDs, IP addresses, secrets or recordings.

## License

MIT. See [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Maintainer: Kuu Miyazaki.
