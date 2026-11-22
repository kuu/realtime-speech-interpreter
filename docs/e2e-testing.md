# End-to-end testing

The harness in `e2e/` plays an English recording into the system the way OBS would, records the Japanese that
listeners would hear, and writes a report with timing numbers. Use it before an event and after every change to
timing settings, dictionaries or the engine. It is the way to measure `e2eFirstWordMs` for **your** material.
The full reference is [`e2e/README.md`](../e2e/README.md). This page is the short version.

## Requirements

- Python 3.9 or newer, Node.js 20 or newer (22 recommended), and `npm ci` in `app/` (the harness uses its LiveKit SDK).
- AWS CLI v2 with credentials for the account of the stack. The Region defaults to `ap-northeast-1` (`E2E_REGION`),
  the stack name to `SimulTranslation` (`E2E_STACK`).
- ffmpeg with `libsrt` and `libopus` for cloud runs. On macOS the plain `brew install ffmpeg` has no SRT. Use
  `brew install ffmpeg-full`. Local runs work with any ffmpeg.

## Commands

| Command | What it does | Needs a deployed stack |
|---|---|---|
| `./e2e/e2e.sh check` | Is the system ready? Read-only. `--fix` offers repairs. | yes |
| `./e2e/e2e.sh local <clip>` | Runs the app on your machine on a clip, with the file sink. Calls the real Transcribe, Translate or Bedrock and Polly. | no |
| `./e2e/e2e.sh run <clip>` | Streams the clip over SRT (or RTMPS with `--input rtmps`) to the deployed stack and records the LiveKit output. | yes |
| `./e2e/e2e.sh report <run-folder>` | Rebuilds `report.md`. | no |
| `./e2e/e2e.sh compare <run-A> <run-B>` | Side-by-side metrics of two runs. | no |
| `./e2e/e2e.sh langscan <clip>` | Finds Japanese speech in a recording (language identification). | no |

`<clip>` is the path of an audio file. You can also give a number or a name fragment of an `NN_*.m4a` file in the folder
set in `E2E_RECORDINGS` (default `samples/`).
Useful options: `--start 00:05:00`, `--duration 5m`, `--label my-test`, and for `run` `--input srt|rtmps`. `local` also takes `--env KEY=VALUE` to
override one app setting, for example `--env TRANSLATE_ENGINE=llm`.

`local` and `run` bill the same AWS services as a live event for the length of the clip.

## Two channels and Japanese-only runs
- In a two-lane deploy `run` reads the channel list from the listener page's `config.json` and records each channel's track:
  `translation-ja.wav` and `translation-en.wav` (and `side-by-side-<id>.wav`). With one channel the file is `translation.wav`, as before.
- `report.md` is built from the first channel, as for one channel, and ends with **Channels (two-lane run)**: one metrics column per
  channel (counts, `e2eFirstWordMs` and `e2eLastWordMs` percentiles, `commitLagMs`, backlog, COMMIT reasons), the routing counts of
  the language gate per channel (results, kept, dropped, late flips, `lateSpoken`) and the first chunk after a switch (a gap of 8 s
  or more in the channel). The one-channel report is unchanged (tested against a golden file).
- `scoring-sheet.md` is written next to `report.md` when a run has a Japanese-source channel: 30 evenly chosen chunks with source,
  translation and an empty score column (1 to 5). The quality floor for channel 2 is the median score of channel 1 minus 0.5.
- **Japanese only** (`./e2e/e2e.sh run <recording> --japanese-only`): for a recording with no English speech, for example the script
  `samples/scripts/monologue-ja.txt` read aloud or generated with `samples/make-samples.sh monologue-ja`. The report states the mode.
  The recording is the owner's to make; this repository has no audio.
- **`simple` versus `full` Japanese segmentation:** run the same recording twice (`-c jaSegmentationMode=simple`, then `full`, one
  deploy each) and run `./e2e/e2e.sh compare <run A> <run B>`; the report ends with the Japanese cut reasons side by side.

## Read the report

Each run writes `e2e/runs/<time>_<label>_<clip>/` with these files:

| File | Use |
|---|---|
| `translation.wav` | The Japanese output. Time zero is the stream start. |
| `side-by-side.wav` | Left channel English, right channel Japanese, aligned. Listen to this first. |
| `report.md` | Settings, summary numbers, chunk table, and a section for your own judgement (kept when the report is rebuilt). |
| `app.log` | The app log of that run. |

| Metric | Meaning | Good sign |
|---|---|---|
| `e2eFirstWordMs` (avg, p50, p90, max) | Speaker says a chunk, listener hears its first word. | p50 around 6000 with the `talk` profile. |
| `e2eLastWordMs` | Same for the last word of a chunk. | Close to the first-word value plus the speech length. |
| `commitLagMs` | Time from the last word spoken to the cut of the chunk. | Small. |
| `maxBacklogMs` | The longest queue of speech waiting to play. | Below the `maxBacklogMs` setting. |
| Chunks by COMMIT reason | Why chunks were cut (sentence, clause, pause, max words). | A mix, not only `max_words`. |
| played, dropped, skipped, failed | What happened to each chunk. | dropped and failed near 0. |
| Speed histogram and timeline | Polly speed levels used. | Mostly the lowest levels, few big jumps. |
| Fragmentation | Chunks that end on a dangling word or are 3 words or fewer. | Few. |
| LLM section | Engine per chunk, `llmMs`, fallbacks, tokens, estimated cost. | Few fallbacks. |
| Language filter | Results dropped as non-English. | Drops match real Japanese speech. |
| `[verify]` OK / MISMATCH / LANGDROP | Check that committed words match the final text. | Mostly OK. |

The report cannot judge quality. Listen to `side-by-side.wav`, then write your score in the HUMAN JUDGEMENT section.

## Try it first without a stack

```bash
./e2e/e2e.sh local path/to/clip.wav --label first-try
```

This needs AWS credentials with Transcribe, Translate and Polly access and an installed `app/` (`cd app && npm ci`).
The repository `samples/` folder holds short clips when they are included in your checkout.

## Browser input

The browser path is driven in tests by a LiveKit publisher with identity `browser-publisher` (see
`app/test/ingest-livekit.test.ts` for a local run). Pointing this harness at it is not built; it is on the live-test list
in [security.md](security.md#browser-microphone-input).

## RTMPS input
`./e2e/e2e.sh run` sends over SRT by default. To send over RTMPS instead, deploy the stack with `-c inputSource=rtmps`
and run:
```bash
./e2e/e2e.sh check --input rtmps
./e2e/e2e.sh run --input rtmps --file 1 --start 00:10:00 --duration 5m --label rtmps
```
`rtmp` is accepted as an alias of `rtmps` (a note says it means RTMPS); other values are an error.

- The harness reads the URL from the `RtmpsUrl` output and the stream key from the secret named in
  `RtmpsStreamKeySecretArn` (read-only calls). It never prints the key. It is in ffmpeg's argument list while the run
  streams, so other users of the same Mac could see it with `ps`.
- Without the `RtmpsUrl` output (stack deployed without `inputSource=rtmps`), `check --input rtmps` and `run --input rtmps`
  stop with a clear message.
- Your Mac's public IP must be in the stack's `venueCidr` (for example `203.0.113.10/32`), because the venue allowlist is
  applied on TCP 443 before TLS. The harness prints a reminder but cannot change it.
- The audio is paced at real time. The run records `input` in `meta.json` and `report.md`; `compare` warns when the two
  runs used different inputs.

To send by hand instead, with ffmpeg:
```bash
ffmpeg -re -i path/to/clip.wav -vn -ac 1 -ar 48000 -c:a aac -b:a 128k -f flv \
  "rtmps://rtmps.<LiveKitPublicIp>.sslip.io:443/live/<stream key>"
```
Take the URL from the `RtmpsUrl` output and the key from `GetRtmpsStreamKeyCommand`; do not shorten the name to the IP.
Compare the first-word delay with an SRT run of the same clip (the app logs are the same for both inputs).
## Safety notes

- `check`, `report`, `compare` and `langscan` do not change AWS. `check --fix` asks before each change and never
  opens a security group without you typing `y`.
- `run` refuses to start when `check` says NOT READY, and it needs your IP allowed: the SRT port for SRT, `venueCidr` for RTMPS.
- The harness mints its own subscribe-only token and never prints secrets.
