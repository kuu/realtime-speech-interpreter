# E2E test harness: English → Japanese simultaneous translation

Use this after every improvement. It plays a real event recording into the system, records the
Japanese output, and writes a report. You listen to the result and score it.

Everything runs from macOS zsh, from any directory. The entry point is `e2e/e2e.sh` (bash +
Python 3 stdlib + Node). It adds no new packages: the LiveKit recorder and the language scan load
the SDKs already installed in `app/node_modules`.

| Command | What it does |
|---|---|
| `check` (alias `ensure-running`) | Reports whether the deployed system is ready. With `--fix`, offers repairs. |
| `run` | Cloud E2E, the main mode. Streams a recording over SRT (default) or RTMPS (`--input rtmps`) like OBS and records the LiveKit output. |
| `local` | Offline E2E. Runs the app on this Mac (`INPUT_FILE` + file sink) on the same clip. Needs no deployed stack. |
| `report` | Rebuilds `report.md` for a run folder. Your HUMAN JUDGEMENT section is kept. |
| `compare` | Puts two runs' metrics side by side and writes `compare.md`. |
| `langscan` | Finds Japanese speech in a recording, using Transcribe language identification. |

## Prerequisites

- AWS CLI v2 with credentials for the account you deploy to (`aws sts get-caller-identity`). The region
  defaults to `ap-northeast-1`; override it with `E2E_REGION`. The stack name defaults to
  `SimulTranslation`; override it with `E2E_STACK`. Every resource (cluster, service, SGs, secrets,
  URLs) is resolved from the stack's outputs and resources, so nothing is hard-coded.
- ffmpeg with libsrt and libopus. **The plain Homebrew `ffmpeg` formula has no SRT**, so `brew install ffmpeg`
  is not enough for `run`. Install the full build:
  ```
  brew install ffmpeg-full
  /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -protocols | grep srt     # must print "srt"
  /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -encoders | grep opus     # must list libopus
  ```
  The harness looks for ffmpeg in this order: `$FFMPEG`, `ffmpeg` on PATH, `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`.
  It uses the first one with SRT and libopus. `local`, `report` and `langscan` work with any ffmpeg.
- Node 22 (`node --version`), plus the app's dependencies: `cd app && npm ci` (once).
- Python 3.9 or newer (`python3 --version`; the macOS one is fine).

## Commands

Replace `cd path/to/your/clone` with your checkout path. All the commands below can also be run from any
directory with the full path to `e2e/e2e.sh`.

```
cd path/to/your/clone

# 1. Is the system up? (read-only)
./e2e/e2e.sh check

# Repair: asks before every change; --yes skips the prompts for ECS/EC2 repairs (never for SG changes)
./e2e/e2e.sh check --fix
./e2e/e2e.sh check --fix --yes

# 2. Cloud E2E: a 5-minute slice of recording 1, starting at 10:00
./e2e/e2e.sh run --file 1 --start 00:10:00 --duration 5m --label baseline

# Cloud E2E: the whole of recording 2 (about 51 min)
./e2e/e2e.sh run --file 2 --label baseline-full
# Cloud E2E over RTMPS instead of SRT (stack deployed with -c inputSource=rtmps)
./e2e/e2e.sh run --input rtmps --file 1 --start 00:10:00 --duration 5m --label rtmps

# 3. Local E2E: the same slice, with the app running on this Mac (settings from cdk/cdk.json)
./e2e/e2e.sh local --file 1 --start 00:10:00 --duration 5m --label baseline
#    ...with the settings of the deployed task definition instead, or with an extra override:
./e2e/e2e.sh local --file 1 --start 00:10:00 --duration 5m --label deployed-cfg --config deployed
./e2e/e2e.sh local --file 1 --start 00:10:00 --duration 5m --label minwords10 --env CHUNK_MIN_WORDS=10
#    ...with the LLM translation engine (Bedrock; the default is Amazon Translate):
./e2e/e2e.sh local --file 1 --start 00:10:00 --duration 5m --label llm-haiku --env TRANSLATE_ENGINE=llm

# 4. Compare two runs (prints the table and writes e2e/runs/compare_<A>__vs__<B>.md)
./e2e/e2e.sh compare e2e/runs/<run-A-folder> e2e/runs/<run-B-folder>

# Rebuild a run's report.md (for example after `langscan`; your judgement section is kept)
./e2e/e2e.sh report e2e/runs/<run-folder>

# 5. Find Japanese speech (Transcribe en-US/ja-JP language ID, real-time pace: all 4 files take ~51 min in parallel)
./e2e/e2e.sh langscan all
./e2e/e2e.sh langscan 3 --start 0 --duration 5m
```

Options for `run` and `local`:
- `--file`: `1`-`4`, a fragment of the file name, or a path. The number can also be given on its own, as in `run 1`.
- `--start`: offset into the recording, for example `00:05:00`, `5:00`, `300` or `5m`.
- `--duration`: for example `5m`, `90s` or `00:02:00`. The default is the rest of the file.
- `--label`: the run name.

Options for `run` only:
- `--input srt|rtmps`: how the audio is delivered. `srt` is the default and behaves as before. `rtmps` sends
  AAC (48 kHz, mono) in FLV over RTMPS to the stack's `RtmpsUrl` output, with the stream key from the
  secret in `RtmpsStreamKeySecretArn`. `rtmp` is accepted as an alias and means RTMPS (a note is printed).
  Any other value is an error. `check` takes the same option. See [RTMPS input](#rtmps-input).
- `--countdown N`: seconds before streaming starts. Default 10.
- `--ingest 2`: use the second SRT ingest IP (SRT only; an error with `--input rtmps`).
- `--bitrate`: Opus bitrate for SRT, AAC bitrate for RTMPS. Default `128k`.
- `--drain-timeout`: how long to wait for queued translations after the stream ends. Default 180 s.

### What `check` verifies and repairs

| Check | OK when | `--fix` repair (each one prints the command and asks first) |
|---|---|---|
| Stack status | `CREATE_COMPLETE` / `UPDATE_COMPLETE` (`UPDATE_ROLLBACK_COMPLETE` gives a warning) | none |
| LiveKit EC2 (`LiveKitInstanceId`) | `running` | stopped → `aws ec2 start-instances`, then wait for running and for the TLS endpoint |
| LiveKit TLS endpoint | `https://<LiveKitUrl host>/` returns any HTTP response | none |
| ECS service | desiredCount ≥ 1 and running = desired; prints the task def revision | desiredCount 0 → `update-service --desired-count 1`, then wait for the task and its startup lines |
| Crash loop | fewer than 2 tasks stopped on their own in the last 30 min | prints the stopped reason and the last 40 log lines. Not repaired: fix the cause first |
| Latest task started cleanly | its log stream `app/app/<taskId>` contains `[livekit] connected` and `[srt] listening on port 9000` | if missing, the task counts as unhealthy (see below) |
| NLB target health | `healthy` | unhealthy counts as an unhealthy task |
| LiveKit room | `publisher-app` is publishing audio in room `translation` (checked with a server-API call) | if not, the task counts as unhealthy |
| Unhealthy running task | none of the three problems above | `update-service --force-new-deployment`. The old task stops first, so expect 1-3 min with no service |
| SRT listener idle | no other SRT publisher (OBS) is connected right now | none: stop OBS |
| Listener page (`ListenerUrl`) | HTTP 200 | none |
| This Mac's public IP (from https://checkip.amazonaws.com) | allowed on UDP 9000 in **both** NlbSg and AppSg | prints the exact `aws ec2 authorize-security-group-ingress` commands for both SGs (UDP 9000, `<ip>/32` only). With `--fix` it offers to run them, but only after you type `y`; `--yes` never covers this. 0.0.0.0/0 is never used. |

Exit code: 0 = READY, 1 = NOT READY. `run` performs the same check (read-only) first and refuses to
stream if the result is NOT READY.

A manually added SG rule is **removed by the next `cdk deploy`** unless the IP is also in `venueCidr`.
To keep it, deploy from `cdk/` with **every** CIDR the SGs allow today plus the new one, comma-separated.
Take the current list from the `allows:` lines that `check` prints for NlbSg/AppSg. Any CIDR you leave
out is removed by the deploy, and SRT from that network then fails silently. With today's two CIDRs:

```zsh
cd cdk && npx cdk deploy -c venueCidr=203.0.113.10/32,198.51.100.7/32,<new-ip>/32
```

## RTMPS input
`--input rtmps` needs a stack that was deployed with `-c inputSource=rtmps` (it then has the outputs `RtmpsUrl` and
`RtmpsStreamKeySecretArn`). Prerequisites and behavior:
- `check --input rtmps` (and `run --input rtmps`) fails with a clear message when the stack has no `RtmpsUrl`
  output. It then expects `[rtmp] listening on port` instead of `[srt] listening on port` in the task's startup lines,
  and skips the SRT-specific checks (UDP security groups, "SRT listener idle").
- Network: RTMPS goes to TCP 443 on the LiveKit address. The venue allowlist (`venueCidr`) is applied there before TLS,
  so this Mac's public IP must be in `venueCidr` (for example `203.0.113.10/32`). The harness cannot change this
  and only prints a reminder with your current public IP. Fix it by redeploying with every allowed CIDR plus yours.
- `--input srt` against a stack deployed with `inputSource=rtmps` only prints a warning (the SRT listener may not
  be in use). It does not guess; the run then simply fails if SRT is not reachable.
- ffmpeg needs the `rtmps` protocol (`ffmpeg -hide_banner -protocols | grep rtmps`). The plain Homebrew `ffmpeg` has it.
- The audio is paced at real time (`-re`), as for SRT. The command is
  `ffmpeg -re -i source-clip.wav -vn -ac 1 -ar 48000 -c:a aac -b:a 128k -f flv rtmps://<RtmpsUrl>/<stream key>`.
  The app decodes it with the same arguments as SRT, so the report numbers are comparable.
- `meta.json` and `report.md` record `input` (`srt` or `rtmps`). `compare` shows an `Input` row and warns when the
  two runs used different inputs. Runs made before this option count as `srt`.

```
./e2e/e2e.sh check --input rtmps
./e2e/e2e.sh run --input rtmps --file 1 --start 00:10:00 --duration 5m --label rtmps-baseline
```
## How a cloud run works

1. `check` runs and must say READY.
2. The clip is cut from the recording to `source-clip.wav` (48 kHz mono). This is exactly the audio that gets sent.
3. A headless LiveKit **subscriber** (`e2e/lib/recorder.cjs`) joins room `translation` and subscribes to the
   app's audio track. Its token is minted locally from the LiveKit API key and secret in Secrets Manager
   (`LiveKitApiSecretArn`). The token is subscribe-only (`canPublish=false`, `canPublishData=false`),
   hidden from other participants, and valid for 10 minutes for joining. The secret is passed to Node
   on stdin; it never appears in argv, env vars, files or output.
4. The harness prints the **ListenerUrl** and counts down, so you can open the page, tap the button and put on headphones.
5. ffmpeg streams the clip like OBS does: `-re` (real-time pace), Opus, mono, 48 kHz, in MPEG-TS, as an SRT
   **caller**. The URL comes from `ObsSrtUrlTemplate` (`mode=caller&latency=120000&pbkeylen=16`). The
   app's `srt-source.ts` is the SRT listener and decodes any codec ffmpeg can read to 16 kHz PCM. The
   passphrase is fetched from Secrets Manager at runtime and exists only in memory and in ffmpeg's
   argument list. Every echoed command and log line shows it as `***`. With `--input rtmps`, ffmpeg sends
   AAC in FLV over RTMPS instead, and the stream key is handled the same way as the passphrase.
6. When the stream ends, the harness waits for the backlog to drain: until the app logs `[summary] session=N`
   and every committed chunk has reached PLAYED, DROPPED, SKIPPED or FAILED (timeout 180 s). It then
   collects that session's lines from `/simul-translation/app` by time window.
7. The recorder output is re-based so that sample 0 = the moment streaming started (wall clock). The
   report includes an alignment check: the first Japanese audio in the recording against the time the
   app's log predicts. The verification run differed by +0.13 s.

The local mode does the same with the app running on the Mac: `INPUT_FILE` (16 kHz s16le raw, cut from
the same clip) and `AUDIO_SINK=file`. The
file sink writes the Japanese audio back to back. The harness then places each chunk at the time a
listener would have heard it (from the `PLAYED … e2eFirstWordMs` lines), so local and cloud
`translation.wav` files share a timeline. By default the app settings come from `cdk/cdk.json`, the
same values the stack passes to the container, so an improvement can be judged locally before it
is deployed. `--config deployed` uses the running task definition instead. Local runs still call the
real Transcribe, Translate and Polly.

## Output: one folder per run

`e2e/runs/<YYYYmmdd-HHMMSS>_<label>_<recording>/` (git-ignored by `e2e/.gitignore`):

| File | Content |
|---|---|
| `translation.wav` | The Japanese output, 16 kHz mono. Sample 0 = stream start. |
| `source-clip.wav` | The exact English input segment, 48 kHz mono. |
| `side-by-side.wav` | Stereo, 24 kHz: **left = English source, right = Japanese**, time-aligned. You hear lag and content together. |
| `app.log` | That session's app log lines. For local runs, the whole local app output. |
| `report.md` | The settings in effect, a summary, the speed timeline, the possible Japanese speech, the chunk table and the HUMAN JUDGEMENT template. |
| `meta.json`, `metrics.json` | Run metadata and metrics, used by `report` and `compare`. Contains no secrets. |
| `startup.log`, `recorder.log`, `stream.log` | Cloud runs only: the task's startup lines, the recorder's events, and ffmpeg warnings (redacted). |

`report.md` contains:
- the **settings** parsed from the app's startup lines (segmentation, playback/speed-up, fillers, langfilter);
- a **summary**: chunk counts by COMMIT reason; played/dropped/skipped/failed; avg/p50/p90/max
  `e2eFirstWordMs`; `maxBacklogMs`; the Polly speed-rate histogram (`SYNTH rate=`); the speed-level
  histogram (`SYNTH level=`, `SPEED_MODE=levels`); level changes (per minute of clip) and the max level jump
  between consecutive synthesized chunks; rate changes per minute and the max rate jump in % points (also
  for older logs without levels); the `speedWhy` counts (target/slew/hold/hyst/urgent/reset/steps/off);
  WAV durations and volumedetect levels. `compare` shows the same speed rows. Every run also shows
  `e2eLastWordMs` p50 / p90 / max and `commitLagMs` avg / p90 (older runs get them when the report is rebuilt);
- the **LLM engine** section (only when the log's `SYNTH` lines carry `engine=`, that is runs of a build with the LLM
  engine; older runs show no such section and no `Eng` column): chunks by engine (`llm` / `translate` / `fallback`),
  `llmMs` avg / p50 / p90 / max (chunks with an LLM call, timed-out calls included) next to `translateMs`
  avg / p50 / p90 of the `engine=translate` chunks, fallbacks by reason (`fallbackReason=`), the counts of
  `LLM_FALLBACK` / `LLM_REJECT` lines, how often the breaker opened (`[llm] BREAKER open`), the cache hit rate
  (cacheRead / (inTok + cacheRead + cacheWrite)), token totals and the estimated cost (Haiku 4.5 list price, the
  `jp.` profile premium is not included). These numbers come from the chunk lines of the run. The last
  `[llm-summary]` line (cumulative for the whole app process, warm-up and keep-warm calls included) is quoted as
  is. The Chunks table gets an `Eng` column: `llm`, `translate` or `fb:<reason>`. The `llm ` startup line
  appears in the settings table as `llm.*`. `compare` adds the same rows (hidden when neither run has them);
- the **speed timeline**: one line per source minute with one glyph per synthesized chunk (▁ = 100% … █ = 150%,
  the same scale for every run) and the levels (`L3`, `!` = urgent jump) or, for older logs, the rates;
- **Fragmentation** (quality v1): counts of chunks that end on a dangling word (preposition, article, "that", "to", ...)
  without `.?!`, continuation chunks (lowercase start after a chunk without `.?!`) and chunks of 3 words or fewer,
  each with an offender list (chunk, EN, JA), plus a table showing whether the chunk texts listed from an
  evidence run (`you're used to.`, `different layouts.`, ...) are still separate chunks or merged. `compare` shows the
  three counts;
- **Possible Japanese / non-English speech**: rows whose English transcript contains Japanese characters
  (`ja-chars`), romanized Japanese (`romaji`) or very few English function words (`low-english`), or that
  overlap a ja-JP range found by `langscan` (`langscan-ja`, the most reliable flag);
- **Language filter** (app with `LANGUAGE_FILTER=langid`): every Transcribe result the app dropped as
  non-English (`[langfilter] dropped`), counted by reason, with dropped words; drops that overlap a
  `langscan` ja-JP range (correct drops) vs. drops that don't (**suspected false drops of English**,
  listed first; listen to `source-clip.wav` there); played chunks that still overlap `langscan-ja`; and the
  `[verify]` OK / MISMATCH / LANGDROP counts (LANGDROP = a result already committed turned out to be
  Japanese; its unspoken words were removed, which is not a loss of English). Older logs show
  "no language-filter lines (filter off or older build)". `compare` shows the same numbers per run
  (`Lang-filter drops`, `…suspected false drops`, `Played chunks overlapping langscan-ja`, `[verify]`);
- the **chunk table**: index, time in the source recording, EN, JA, rate, level, speed timeline (glyph,
  level, ↑/↓ vs the previous synthesized chunk, `!` = urgent), e2e latency, status and flags.

## How to listen and judge

1. During a cloud run, listen live on the ListenerUrl with headphones. That is the attendee experience.
2. Afterwards, play `side-by-side.wav` (QuickTime or `afplay`). With headphones, English is in the left ear
   and Japanese in the right. Listen for:
   - **Accuracy**: does the Japanese say what the English said?
   - **Fluency**: is it natural Japanese, or fragments?
   - **Latency**: how far behind the speaker is it? Compare with the `e2e` column.
   - **Naturalness of speed**: does the speed ramp smoothly (levels L1-L5 = 100/110/120/130/145 %, one
     level per chunk at most, except `urgent` catch-up and `reset` after a pause) or are there audible jumps? Use the report's speed timeline to find the
     fast passages (L4/L5, `!` = urgent jump). With `SPEED_MODE=steps` (the old behaviour) the rate jumps
     between 100/115/130/150 %.
   - **Japanese speech**: is it ignored? For the slices below, the right channel should stay silent
     while the Japanese moderator or audience speaks.
3. Fill in the HUMAN JUDGEMENT table at the end of `report.md`, with scores from 1 to 5 and notes. `compare`
   picks up the scores.
4. Compare with the baseline: `./e2e/e2e.sh compare e2e/runs/<baseline> e2e/runs/<new>`.

## Standard test set

Judge every improvement on the same audio. Run the same set before the change (baseline, or with the
`--label` of the deployed version) and after it. Use `local` for quick iterations and `run` for the
final confirmation on Fargate.

Recordings: the harness reads audio files named `NN_*.m4a` (any ffmpeg-readable stereo or mono AAC; it downmixes to
mono like OBS's mono mic input) from `E2E_RECORDINGS=<dir>` (default `samples/`). Real conference recordings are not
part of this repository; use your own, or the sample clips in `samples/` once they exist. Slices of 5 minutes taken mid-talk
work well for quick iterations:
```
./e2e/e2e.sh local --file 1 --start 00:10:00 --duration 5m --label <name>
./e2e/e2e.sh local --file 2 --start 00:10:00 --duration 5m --label <name>
```
### Japanese speech test slices
`./e2e/e2e.sh langscan all` runs Transcribe streaming language ID (en-US + ja-JP) over every recording. Output:
`e2e/runs/langscan/langscan.md`, with one `*.jsonl` per recording. Once these files exist, every `report.md` flags
chunks that overlap a ja-JP range (`langscan-ja`). Re-run `report` on older runs to add the flag.
Pick slices where Japanese speech (a moderator or audience questions) is mixed with English. They show both
requirements: Japanese must stay silent, and English must still be translated.
```
# moderator intro in Japanese, then the English talk starts
./e2e/e2e.sh local --file 1 --start 00:00:00 --duration 90s --label <name>
# Q&A: Japanese questions with English answers (use the ja-JP ranges from langscan.md)
./e2e/e2e.sh local --file 1 --start 00:26:00 --duration 4m --label <name>
```
(For the cloud, replace `local` with `run`.)
## Cost notes

Every run, local or cloud, uses the real Transcribe streaming, Translate and Polly (neural) APIs. Billing is per
audio second and per character. These are US East list prices; check the Tokyo prices on the pricing
pages ([Transcribe](https://aws.amazon.com/transcribe/pricing/),
[Translate](https://aws.amazon.com/translate/pricing/), [Polly](https://aws.amazon.com/polly/pricing/)):

| Service | Rate (approx.) | Per minute of talk (measured: ~700 EN / ~360 JA characters per min) |
|---|---|---|
| Transcribe streaming | ~$0.01-0.024 / audio minute | ~$0.01-0.024 |
| Translate | ~$15 / million characters | ~$0.011 |
| Polly neural | ~$16 / million characters | ~$0.006 |
| **Total** | | **~$0.03-0.04 per minute**: a 5-min slice is about $0.2, a full 50-min file about $2 |

`langscan` is Transcribe streaming only: about $0.01-0.024 per audio minute, so all 4 files (~149 min)
cost about $1.5-3.6. The always-on Fargate task, LiveKit EC2 and NLB cost the same whether or not you run tests.

## Troubleshooting

- **IP not allowlisted (silent failure).** The SRT security groups only allow listed venue CIDRs. From any
  other network, UDP packets are dropped without an error. ffmpeg then reports a connection timeout,
  or the app never logs `first audio received`. `check` reports `NOT allowed` and prints the two
  `authorize-security-group-ingress` commands. Mobile tethering and new Wi-Fi change your public IP.
  Re-run `check` after switching networks.
- **Task not running, or crash-looping.** Run `./e2e/e2e.sh check --fix`. Scaled to 0: it offers to set the
  desired count to 1. Crash loop: it prints the last log lines; fix the cause and redeploy. Running but
  unhealthy (no startup lines, NLB target unhealthy, or not publishing in LiveKit): it offers
  `--force-new-deployment`.
- **No audio on the listener page or in `translation.wav`.**
  - Check that `check` shows `publisher-app is publishing audio`. If the LiveKit EC2 was stopped or
    restarted, the app may need `--force-new-deployment` (`check --fix` offers it).
  - On a phone, tap the button again: browsers block autoplay.
  - If `report.md` shows chunks but `translation.wav` is silent, look at `recorder.log`: it must contain
    `TRACK publisher-app`.
  - If the report shows no chunks at all, the app got no audio. See the first bullet, and check
    that the passphrase was not rotated.
- **Only ONE SRT publisher at a time.** The app's ffmpeg listener accepts a single caller. **Stop streaming in
  OBS before a run** (and don't start two runs). `check` fails with `another SRT publisher is connected`
  when the app's log shows an open session.
- **`--input rtmps`: `has no RtmpsUrl` / NOT READY.** The stack was deployed without `-c inputSource=rtmps`. Deploy with
  it (keep your other `-c` settings) or use `--input srt`.
- **`--input rtmps`: ffmpeg fails at once, or the app gets no audio after 45 s.** This Mac's public IP is probably not
  in `venueCidr` (the connection is closed before TLS), the stream key was rotated, or OBS is publishing.
- **`no ffmpeg found with the rtmps protocol`**: `brew install ffmpeg`, or set `FFMPEG=/path/to/ffmpeg`.
- **`no ffmpeg found with SRT (libsrt) and libopus`**: `brew install ffmpeg-full`, or set `FFMPEG=/path/to/ffmpeg`.
- **`app/node_modules missing`**: `cd app && npm ci`.
- **Ctrl-C during a run** stops the stream. The harness still drains, collects the logs and writes the
  report, with the note "stopped early". A second Ctrl-C aborts.
- **Local mode** builds `app` (`npm run build`) first, so it always tests the current code. The app's
  health server binds a random free port on 127.0.0.1 only (`HEALTH_HOST=127.0.0.1`) for the length of
  the run (also the app's default); on Fargate the stack sets 0.0.0.0 for the NLB health check.

## Security

- Secrets (SRT passphrase, LiveKit API secret) are read from Secrets Manager at runtime. They are kept
  in memory, replaced by `***` in all printed text and saved logs, and never written to disk. The
  passphrase has to be in ffmpeg's SRT URL, so while a run streams, other processes **on this Mac**
  can see it with `ps`. Don't run the harness on a shared machine.
- The RTMPS stream key (`--input rtmps`) is handled the same way: read from Secrets Manager at runtime, replaced
  by `***` in printed text, `stream.log`, `meta.json` and `report.md`, and never written to disk. ffmpeg has no way to
  take an output URL from a file or the environment, so the key is in its argument list, visible with `ps` to
  other processes on this Mac while a run streams. `meta.json` stores the command with `***` and the key-free URL.
- The recorder token is minted locally. It is subscribe-only, hidden, short-lived, and limited to room `translation`.
- Security group changes happen only through `check --fix`, only after an explicit `y`, and only for
  `<current public IP>/32` on UDP 9000.
- Run outputs (`e2e/runs/`) contain recordings and must not be committed (they are in `e2e/.gitignore`).
