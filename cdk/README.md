# simul-translation CDK

Single CDK stack (`SimulTranslation`, ap-northeast-1) for live English → Japanese
simultaneous translation, sized for ~100 listeners and one 4-hour session.

## Architecture

```
Venue PA ─TRS─> M-Track Duo ─> Mac Mini / OBS ──SRT (Opus, AES passphrase)──┐
                                                                            │ UDP 9000, venueCidr only
                                                                            v
                     NLB (internet-facing, 2 static Elastic IPs, UDP listener)
                                                                            │
                                                                            v
     Fargate task "app" (ARM64, image built from ../app/Dockerfile)
       ffmpeg SRT listener -> Transcribe streaming (custom vocabulary)
       -> Translate (custom terminology) -> Polly (Kazuha) -> LiveKit publisher
                                                                            │ wss + WebRTC
                                                                            v
     EC2 LiveKit SFU (OSS, Docker) + Elastic IP
       Caddy :443 (Let's Encrypt, <EIP>.sslip.io) -> LiveKit 127.0.0.1:7880
       ICE/TCP 7881, WebRTC UDP 50000-60000
                                                                            ^
                                                                            │
     Listener phones ── https://<cloudfront>/  (S3 private, OAC)
                     ── GET /token -> Lambda (function URL, IAM/OAC) -> subscribe-only JWT
```

- VPC: 2 public subnets, no NAT. Fargate gets a public IP for egress only; security groups
  are the boundary.
- Secrets Manager: `LiveKitApiSecret` (`{apiKey, apiSecret}`, shared by app, SFU and token
  Lambda) and `SrtPassphraseSecret` (32 chars). Both generated; never in code or outputs.
- Logs: `/simul-translation/app`, `/simul-translation/livekit` (LiveKit + Caddy containers),
  `/simul-translation/token` (14-day retention).
- NLB health check is TCP on the app's `HEALTH_PORT` (8080); UDP itself can't be health-checked.

## Prerequisites

- AWS CLI v2 with credentials for the target account, Node.js 22, npm.
- Docker running: the app image is built during `cdk deploy`. The task is ARM64; Apple Silicon
  builds it natively. On an x86 machine, Docker buildx with QEMU (arm64 emulation) is required.
- One-time bootstrap: `npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1`
- `npm install` in this directory.

## Deploy

1. Create the dictionaries (needed before OBS connects; see [Dictionaries](#dictionaries)):
   ```
   ./scripts/dictionaries.sh
   ```
2. Deploy with the venue's public egress IP (required; synth fails without it, `/0` is rejected):
   ```
   npx cdk deploy -c venueCidr=203.0.113.10/32
   # several ranges:
   npx cdk deploy -c venueCidr=203.0.113.0/28,198.51.100.7/32
   ```
   Find the venue egress IP from the Mac Mini on the venue network: `curl https://checkip.amazonaws.com`.

**Easier way:** copy `config/event.example.json` to `config/event.json`, edit it, run `../scripts/doctor.sh`, then `npx cdk deploy` without `-c` flags. Profiles, precedence and every key: [docs/configuration.md](../docs/configuration.md). `npm test` runs the config tests; `npm run doctor` runs the preflight check.

All other settings live in `cdk.json` → `context` and can be overridden with `-c key=value`:
`srtPort`, `srtLatencyMs`, `srtListenTimeoutSec`, `srtAnalyzeMs`, `healthPort`, `sampleRate`, `frameBytes`,
`sourceLanguage`, `partialStability`, `languageFilter`, `languageOptions`, `langidSettleWords`, `langidSettleMode`, `langidSettleWordsDefault`, `langidSettleWordsAfterJa`, `langidJaMemoryMs`,
`langidShortWords`, `langidShortMinConf`, `segmentationMode`, `chunkMinWords`, `chunkMaxWords`,
`chunkMaxMs`, `chunkPauseMs`, `chunkConjunctions`, `mergeShort`, `sentenceMinWords`, `sentenceCompleteWords`, `mergePauseMs`,
`mergeMaxHoldMs`, `danglingGuard`, `danglingWords`, `danglingMaxWords`, `danglingMaxHoldMs`, `cutLookaheadMs`, `shortSentenceJoin`, `shortSentenceWords`, `shortJoinPauseMs`, `speedMode`, `speedLevels`, `speedThresholdsMs`, `speedHysteresisMs`, `speedHoldMs`,
`speedUrgentMs`, `speedLookahead`, `speedMsPerChar`, `speedResetGapMs`, `speedupSteps`, `maxBacklogMs`, `fillerFilter`, `fillerWords`, `fillerPhrases`,
`jaFillerPatterns`, `enableCorrection`,
`translateSource`, `translateTarget`, `translateFormality`, `translateEngine`, `llmModelId`, `llmTimeoutMs`, `llmContextChunks`, `llmContextResetMs`, `llmGlossary`, `llmMaxTokens`, `llmBreakerMs`, `llmSkipBacklogMs`, `llmParallelFallback`, `llmMaxCharsPerWord`, `llmKeepWarmMs`, `llmPromptVersion`, `latencyPreset`, `transcribeVocabularyName`, `translateTerminologyName`
(set `""` to disable), `pollyVoice`, `pollyEngine`, `pollySampleRate`, `pollyReadings`, `roomName`,
`publisherTokenTtl`, `listenerTokenTtlSec`, `livekitApiKey`, `livekitHostname`,
`livekitInstanceType`, `livekitImage`, `caddyImage`, `livekitUdpPortStart`, `livekitUdpPortEnd`,
`livekitTcpPort`, `taskCpu`, `taskMemoryMiB`, `desiredCount`, `logLevel`, `logRetentionDays`, `region`, `appPath`.
Pass the same `-c venueCidr=...` on every later `deploy`/`diff`/`destroy`.

First deploy: Caddy needs 1–3 minutes after the instance boots to get the certificate. Until
then the app can't connect to LiveKit and ECS restarts the task; it settles on its own.

## Ignoring Japanese speech (language filter)

With `languageFilter=langid` (default) the app opens Transcribe with multi-language
identification (`IdentifyMultipleLanguages`, `LanguageOptions=languageOptions`,
`PreferredLanguage=sourceLanguage`; the existing en-US vocabulary is passed as `VocabularyNames`).
Every result is tagged with its language, and only `en-US` results are translated and spoken:
the Japanese moderator and Japanese audience questions are dropped, and English answers between
them are still translated. Settings take effect only after you deploy.

| Context key | Env var | Default | Meaning |
|---|---|---|---|
| `languageFilter` | `LANGUAGE_FILTER` | `langid` | `langid` = drop non-English results; `off` = revert switch, the previous single-language en-US request (Japanese is transcribed as English-looking words and translated, as before) |
| `languageOptions` | `LANGUAGE_OPTIONS` | `en-US,ja-JP` | Languages Transcribe chooses between: 2-5 codes, one per language, must include `sourceLanguage` |
| `langidSettleWords` | `LANGID_SETTLE_WORDS` | `5` | An English result is committed only once it has this many stable words (the language can flip once near the start of a result); integer 1-50. No effect on mid-sentence chunking with `chunkMinWords` ≥ 5 |
| `langidSettleMode` | `LANGID_SETTLE_MODE` | `fixed` | `fixed` = every result needs `langidSettleWords` stable words; `dynamic` = `langidSettleWordsDefault` while no Japanese result was seen in the last `langidJaMemoryMs`, `langidSettleWordsAfterJa` after one, and for a result whose partials shrink before it settles (Transcribe rewriting itself, typical for the first Japanese turn after English). Case-insensitive (`-c latencyPreset=fast -c langidSettleMode=Fixed` turns the preset's dynamic mode back off; the lower-case cdk.json value `fixed` cannot override a preset, see Latency presets) |
| `langidSettleWordsDefault` | `LANGID_SETTLE_WORDS_DEFAULT` | `3` | Dynamic mode: stable words when no Japanese result was seen recently; integer 1-50 |
| `langidSettleWordsAfterJa` | `LANGID_SETTLE_WORDS_AFTER_JA` | `5` | Dynamic mode: stable words within `langidJaMemoryMs` after a Japanese result; integer 1-50 |
| `langidJaMemoryMs` | `LANGID_JA_MEMORY_MS` | `60000` | Dynamic mode: how long after a Japanese result the longer threshold applies; integer 0-600000 |
| `langidShortWords` | `LANGID_SHORT_WORDS` | `4` | Also drop an English result of at most this many words with low confidence that comes right after a Japanese one (fragments inside a Japanese passage, e.g. "more.", "sleep."); integer 0-20, `0` disables |
| `langidShortMinConf` | `LANGID_SHORT_MIN_CONF` | `0.6` | Mean word confidence below which that short result is dropped; 0-1 |

```
# revert to the previous behaviour (translate everything Transcribe hears as English)
npx cdk deploy -c venueCidr=<cidr> -c languageFilter=off
```

No new AWS resource and no new IAM permission are needed: language identification is a
parameter of `transcribe:StartStreamTranscription`, and a ja-JP custom vocabulary is not required
(Transcribe only needs one vocabulary that matches one of the language options). A confidence-only
filter on the en-US stream was evaluated and not implemented: partial results carry no confidence,
so it could only decide at the end of a result (adding seconds of latency) and the margin between
Japanese and English confidence was thin. Dropped results are logged as
`[langfilter] dropped result=… reason=non-english|short-low-conf|non-english-late|non-english-eof lang=ja-JP … text="…"`,
with a `[langfilter] stream=N results=… kept=… dropped=…` summary per Transcribe stream.

## Latency / segmentation tuning

The app translates in clause-sized chunks while the speaker is still talking (Transcribe
partial results with stabilization; only stable words are committed, each word exactly once).
`backlogMs` = how late a chunk's Japanese would start relative to its last English word (measured
at synth time). Japanese speech is usually longer than the English, so during long continuous
speech the backlog grows; the app speaks faster (graded levels, see "Polly speed levels"), and above the cap drops the oldest
queued chunks (logged `[chunk N] DROPPED reason=backlog`) so listeners stay within `maxBacklogMs` (default 15 s) of the speaker.

| Context key | Env var | Default | Meaning |
|---|---|---|---|
| `segmentationMode` | `SEGMENTATION_MODE` | `clause` | `clause` = mid-sentence chunks; `sentence` = translate whole sentences (revert switch; use with `maxBacklogMs=0`, otherwise whole sentences are dropped under sustained speech) |
| `chunkMinWords` | `CHUNK_MIN_WORDS` | `8` | Min words (fillers like "um" excluded) before a comma / conjunction / max-time cut |
| `chunkMaxWords` | `CHUNK_MAX_WORDS` | `22` | Hard word cap per chunk (clause mode) |
| `chunkMaxMs` | `CHUNK_MAX_MS` | `0` | Flush a chunk open this long once it has ≥ min words (clause mode). `0` disables |
| `chunkPauseMs` | `CHUNK_PAUSE_MS` | `900` | Flush pending stable words after this long with no new transcript activity. `0` disables (while short text is held, `mergePauseMs` applies instead) |
| `chunkConjunctions` | `CHUNK_CONJUNCTIONS` | `because,but,although,though,while,which` | Cut before these words once ≥ min words (`""` disables) |
| `mergeShort` | `MERGE_SHORT` | `on` | Merge short sentences (clause mode only): a sentence end (`.?!`) or Transcribe final that would give a chunk with fewer than `sentenceMinWords` words is held and joined with the next text (internal periods kept; a period followed by a lowercase word is not treated as a sentence end). `off` = previous behaviour exactly |
| `sentenceMinWords` | `SENTENCE_MIN_WORDS` | `8` | Min words (fillers excluded) for a sentence/final cut when merging; integer 1-100 |
| `sentenceCompleteWords` | `SENTENCE_COMPLETE_WORDS` | `5` | Merge on: a `.?!` that ends a sentence of at least this many words (fillers excluded, counted from the previous `.?!`, including words of the same sentence already sent in an earlier chunk) is cut at once even when the chunk is shorter than `sentenceMinWords`, so a complete sentence ("We have about 10 minutes.", "Can I ask you to clarify the entitlement question?") is never held for the next one. Fragments ("OK.", "I see.") still merge. Logged as `reason=sentence`. `0` = previous merge behaviour exactly; values ≥ `sentenceMinWords` have no effect; integer 0-100 |
| `srtAnalyzeMs` | `SRT_ANALYZE_MS` | `500` | ffmpeg input probing of the SRT stream (`-analyzeduration`, ms). With ffmpeg's default (~5 s for MPEG-TS) the first ~5 s of every SRT connection are held and then released at once; the language-ID Transcribe stream (`languageFilter=langid`) keeps that burst as a permanent lag for the whole session (measured: +5.1 s on every chunk). 500 ms: first PCM after 0.4-0.9 s instead of 4.9-5.4 s, Opus and AAC senders, Homebrew ffmpeg and the image's ffmpeg 5.1. Each stream logs `startBurstMs=` (expected < 1000). `0` = ffmpeg default (revert); integer 0-10000 |
| `mergePauseMs` | `MERGE_PAUSE_MS` | `1500` | Commit held text after this long with no new transcript activity (`reason=merge_pause`). `0` disables; integer 0-60000 |
| `mergeMaxHoldMs` | `MERGE_MAX_HOLD_MS` | `6000` | Safety valve: commit held text once its oldest word is this old (`reason=merge_hold`); integer 1000-60000, cannot be disabled |
| `danglingGuard` | `DANGLING_GUARD` | `on` | Quality v1: never end a chunk on a word that needs a continuation (preposition, article, relative pronoun, "to", "that", ...). Comma/conjunction cuts are skipped after such a word, `max_words` is extended by up to `danglingMaxWords`, and pause/final/merge cuts wait up to `danglingMaxHoldMs` for the next word. `.?!` and end of stream never wait. `off` = revert (previous cutting) |
| `danglingWords` | `DANGLING_WORDS` | `""` | Comma list of words that dangle (no spaces); `""` = the built-in list |
| `danglingMaxWords` | `DANGLING_MAX_WORDS` | `2` | Extra words `chunkMaxWords` may grow by to avoid a dangling end; integer 0-20 |
| `danglingMaxHoldMs` | `DANGLING_MAX_HOLD_MS` | `500` | Longest wait of a pause/final/merge cut that would end on a dangling word; integer 0-10000 |
| `cutLookaheadMs` | `CUT_LOOKAHEAD_MS` | `0` | Quality v1: a mid-sentence pause/final cut waits this long for the next word before it is made, so a Transcribe result boundary does not split a sentence. `0` = off (default; 300-500 buys fewer mid-sentence splits at about +0.5 s first-word latency); integer 0-5000 |
| `shortSentenceJoin` | `SHORT_SENTENCE_JOIN` | `on` | Quality v1: tiny held sentences (at most `shortSentenceWords` words) wait `shortJoinPauseMs` instead of `mergePauseMs` and are sent to Translate comma-joined ("There's small, medium, and large."). The comma join changes only the text sent to Translate, not the exactly-once check. `off` = revert |
| `shortSentenceWords` | `SHORT_SENTENCE_WORDS` | `3` | Max words of a "tiny" sentence; integer 1-6 |
| `shortJoinPauseMs` | `SHORT_JOIN_PAUSE_MS` | `1000` | Silence that releases held tiny sentences; `0` = use `mergePauseMs`; integer 0-10000 |
| `translateFormality` | `TRANSLATE_FORMALITY` | `FORMAL` | Amazon Translate formality for Japanese (keeps です/ます tone, avoids "慣れてるだろ"). `INFORMAL` or `off` (parameter not sent) = revert |
| `translateEngine` | `TRANSLATE_ENGINE` | `translate` | `translate` = Amazon Translate only (no Bedrock, no extra IAM). `llm` = Claude on Bedrock with Translate as fallback; adds the IAM statements in [LLM translation engine](#llm-translation-engine-optional) |
| `llmModelId` | `LLM_MODEL_ID` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | Japan inference profile id. With `translateEngine=llm` it must start with `jp.` (IAM scoping is defined for that profile only) |
| `llmTimeoutMs` | `LLM_TIMEOUT_MS` | `1500` | Per-chunk LLM timeout before falling back to Translate; integer 200-10000 |
| `llmContextChunks` | `LLM_CONTEXT_CHUNKS` | `3` | Previous chunks sent as context; integer 0-6 (0 = none) |
| `llmContextResetMs` | `LLM_CONTEXT_RESET_MS` | `60000` | Source-time gap that clears the context; integer 0-600000 (0 = never) |
| `llmGlossary` | `LLM_GLOSSARY` | `full` | `full` = whole Translate terminology in the cached system prompt; `off` = no glossary and no prompt cache |
| `llmMaxTokens` | `LLM_MAX_TOKENS` | `400` | Output token cap; integer 48-1000 |
| `llmBreakerMs` | `LLM_BREAKER_MS` | `30000` | How long the circuit breaker sends everything to Translate; integer 1000-600000 |
| `llmSkipBacklogMs` | `LLM_SKIP_BACKLOG_MS` | `0` | Use Translate for chunks whose projected backlog exceeds this; integer 0-60000 (0 = off) |
| `llmParallelFallback` | `LLM_PARALLEL_FALLBACK` | `off` | `on` = also start Translate in parallel with every LLM call (faster failure recovery, more Translate cost) |
| `llmMaxCharsPerWord` | `LLM_MAX_CHARS_PER_WORD` | `15` | Output-length validation limit; integer 4-40 |
| `llmKeepWarmMs` | `LLM_KEEPWARM_MS` | `240000` | Keep-warm call interval for the prompt cache (5 min TTL); `0` or integer 30000-290000 |
| `llmPromptVersion` | `LLM_PROMPT_VERSION` | `2` | `2` = the prompt tells the model whether each chunk ended a sentence (`chunk_ends_sentence`), so a chunk cut mid-sentence is translated as an open fragment instead of being closed with です/ます。 `1` = the previous prompt (revert). |
| `latencyPreset` | `LATENCY_PRESET` (log only) | `default` | `default` = the values in cdk.json. `fast` = bundle for `translateEngine=llm` that starts each sentence's Japanese earlier, see [Latency presets](#latency-presets). Unknown names fail synth |
| `speedupSteps` | `SPEEDUP_STEPS` | `3000:115,5000:130,7000:150` | Used only with `speedMode=steps` (the previous behaviour): `backlogMs:rate%`, 115% from 3 s backlog, 130% from 5 s, 150% from 7 s. `off` = no speed-up in steps mode |
| `fillerFilter` | `FILLER_FILTER` | `on` | Main switch for filler removal (`off` = translate everything as heard) |
| `fillerWords` | `FILLER_WORDS` | `um,uh,er,ah,hmm,mm,erm,uh-huh` | English filler words, always removed before Translate (whole words) |
| `fillerPhrases` | `FILLER_PHRASES` | `you know,I mean,well,like,sort of,kind of,you see,okay so,so yeah` | Removed only as discourse markers: at chunk/sentence start followed by a comma or nothing, or set off by commas. "do you know", "works well", "I'd like", "this kind of feature" are kept |
| `jaFillerPatterns` | `JA_FILLER_PATTERNS` | `ええと,えーと,えっと,えー,あの,あのー,まあ,ご存知のとおり,ご存知のように,ご存じのとおり,ご存じのように,ほら,つまり、` | Japanese safety net after Translate: stripped (with trailing 、) only at the start or after 。/、 and only when followed by 、/。/end; a pattern ending in 、 only at sentence start |
| `maxBacklogMs` | `MAX_BACKLOG_MS` | `15000` | Latency cap: a queued chunk that would start later than this is dropped whole (oldest first; newest always kept; never cut mid-playback). `0` = never drop. Set `0` with `segmentationMode=sentence` |

Trade-off: smaller chunks = lower latency, but Japanese is verb-final, so a chunk can't reorder
across a cut and very short chunks sound fragmented. Examples (repeat on every deploy, or edit `cdk.json`):
```
# revert to sentence-level translation (previous behaviour, higher latency).
# Always pass maxBacklogMs=0 with sentence mode: whole sentences are long, so the default
# backlog cap drops entire sentences under sustained speech (9 of 52 in a 270 s local test).
npx cdk deploy -c venueCidr=<cidr> -c segmentationMode=sentence -c maxBacklogMs=0
# full revert to the previous behaviour (also no speed-up, no filler removal)
npx cdk deploy -c venueCidr=<cidr> -c segmentationMode=sentence -c maxBacklogMs=0 -c speedMode=off -c fillerFilter=off
# lower latency / better grammar
npx cdk deploy -c venueCidr=<cidr> -c chunkMinWords=4 -c chunkMaxMs=2500
npx cdk deploy -c venueCidr=<cidr> -c chunkMinWords=7 -c chunkMaxMs=4000
# revert merging of short sentences (cut at every sentence end / final again)
npx cdk deploy -c venueCidr=<cidr> -c mergeShort=off
# tune merging: merge less (shorter minimum) / release held text sooner after a pause
npx cdk deploy -c venueCidr=<cidr> -c sentenceMinWords=6
npx cdk deploy -c venueCidr=<cidr> -c mergePauseMs=1200
# revert the complete-sentence release (hold every sentence shorter than sentenceMinWords again)
npx cdk deploy -c venueCidr=<cidr> -c sentenceCompleteWords=0
# revert Quality v1 parts one by one (dangling-word guard, cut look-ahead, short-sentence join, formality)
npx cdk deploy -c venueCidr=<cidr> -c danglingGuard=off
npx cdk deploy -c venueCidr=<cidr> -c cutLookaheadMs=0
npx cdk deploy -c venueCidr=<cidr> -c shortSentenceJoin=off
npx cdk deploy -c venueCidr=<cidr> -c translateFormality=off
# revert the short SRT input probing (ffmpeg default, ~5 s start-up burst)
npx cdk deploy -c venueCidr=<cidr> -c srtAnalyzeMs=0
# disable filler removal
npx cdk deploy -c venueCidr=<cidr> -c fillerFilter=off
# never drop chunks (completeness over latency) / disable the speed-up
npx cdk deploy -c venueCidr=<cidr> -c maxBacklogMs=0
npx cdk deploy -c venueCidr=<cidr> -c speedMode=off
```
A deploy only changes the task definition environment and rolls the ECS service (about 2-3 min).

## Quality v1

Fewer split sentences and a steadier Japanese tone. Three parts, each with its own revert switch (see the table above):

- Corrections (`enableCorrection`, existing switch): context rules for HEBC→HEVC, ABC→AVC, Xixi→Zixi, wrist→RIST and lunch→launch.
- Segmentation: `danglingGuard`, `cutLookaheadMs`, `shortSentenceJoin` (and their tuning keys). Chunks become fewer and longer; shipped tight defaults (iteration 2) measured -0.4 to +0.1 s on avg last-word latency.
- Translate tone: `translateFormality=FORMAL`.

What needs which step:

- The vocabulary rows for `launch`, `launched`, `launches`, `launching` in the generated `transcribe-vocabulary.txt` (source: `terms.csv`) take effect only after you run `cd cdk && ./scripts/dictionaries.sh` yourself. This work did not run it.
- The corrections, segmentation and formality changes ship with the app image, so they need `cdk deploy`. Nothing has been deployed.

## Latency presets
`-c latencyPreset=fast` replaces these defaults (everything else stays as in cdk.json), measured on recorded talks (configuration P3d):

| Key | `default` | `fast` |
|---|---|---|
| `chunkMinWords` | 8 | 5 |
| `chunkMaxMs` | 0 (off) | 2500 |
| `chunkPauseMs` | 900 | 600 |
| `mergeShort` | on | off |
| `shortSentenceJoin` | on | off |
| `danglingMaxHoldMs` | 500 | 250 |
| `langidSettleWords` | 5 | 4 (used only if `langidSettleMode` is set back to `fixed`) |
| `langidSettleMode` | fixed | dynamic |
| `langidSettleWordsDefault` / `langidSettleWordsAfterJa` / `langidJaMemoryMs` | 3 / 5 / 60000 | 3 / 5 / 60000 |
| `llmTimeoutMs` | 1500 | 1200 |

An explicit `-c key=value` always wins over the preset (for example `-c latencyPreset=fast -c chunkMinWords=7`). "Explicit" means a value that differs from the one in cdk.json: passing the cdk.json value itself (`-c chunkMinWords=8`) is indistinguishable from not passing it, so the preset still applies; to keep such a value under `fast`, change it in cdk.json. The preset is applied at synth time and the task logs `latencyPreset=fast` at startup. `fast` is tuned for `translateEngine=llm`; with `translate` the chunker values still apply, but the sweep did not measure that. Revert: omit `latencyPreset` or pass `-c latencyPreset=default`. Expected effect (local runs on recorded talks): the median time from the first English word of a sentence to its first Japanese sound drops by about 1.2 / 3.4 / 1.5 s, with about 1.7 times more, shorter chunks. Finer steps (for example `-c chunkMinWords=6 -c chunkMaxMs=3000`) are in the report's fallback ladder.

## LLM translation engine (optional)

`translateEngine=llm` translates each chunk with Claude Haiku 4.5 on Amazon Bedrock (Japan inference profile), using the
previous chunks as context and the Translate terminology as glossary. Any LLM failure or rejected output falls back to
Amazon Translate for that chunk. The default (`translateEngine=translate`) adds no IAM and behaves as before.

Enable / revert (nothing has been deployed by this change):

```bash
npx cdk deploy -c venueCidr=<cidr> -c translateEngine=llm
# revert
npx cdk deploy -c venueCidr=<cidr> -c translateEngine=translate
```

Before enabling, make sure the terminology is published (`./scripts/dictionaries.sh`, then `--restart-app` so the task
reloads it). The app loads the glossary once at start with `translate:GetTerminology`; without it every chunk uses Translate.
`translateEngine=llm` also needs a non-empty `translateTerminologyName`; synth fails otherwise.

IAM added to the task role only when `translateEngine=llm` (quoted from the synthesized template, account and region
come from the stack environment; the example is `ap-northeast-1`, account `123456789012`):

```json
{
  "Action": "bedrock:InvokeModel",
  "Effect": "Allow",
  "Resource": [
    "arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0",
    "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    "arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
  ]
}
{
  "Action": "translate:GetTerminology",
  "Effect": "Allow",
  "Resource": [
    "arn:aws:translate:ap-northeast-1:123456789012:terminology/simul-translation",
    "arn:aws:translate:ap-northeast-1:123456789012:terminology/simul-translation/*"
  ]
}
```

No wildcard resources and no `InvokeModelWithResponseStream` (the app uses non-streaming Converse). No security group,
listener or ingress change: the task reaches Bedrock over the same outbound path as Transcribe, Translate and Polly.

Data handling: the English transcript text of each chunk (plus up to `llmContextChunks` previous chunks and the glossary)
is sent to Bedrock through the Japan profile, which runs in Tokyo and Osaka only. Per the AWS Bedrock terms, inputs and outputs are not used to
train models and are not shared with model providers; verify against the current terms before relying on this.

## Polly speed levels

Polly speaks faster when the output falls behind the speaker. With `speedMode=levels` (default)
the speed moves through graded levels instead of jumping between slow and fast. The rate is chosen
right before each Polly call, so this adds no processing delay and no extra Polly calls.

- Signal = `backlogMs` + `speedLookahead` × max(0, estimated Japanese ms − English chunk ms), where
  estimated Japanese ms = `speedMsPerChar` × spoken Japanese characters (the look-ahead speeds up a
  long Japanese chunk for a short English chunk before it creates backlog; it never slows down).
- The signal must reach `speedThresholdsMs[i]` to enter level i+2 (L2..L5).
- Smoothing: at most ±1 level per chunk; going down needs the signal `speedHysteresisMs` below the
  threshold of the current level; no change until `speedHoldMs` of audio played at the current level
  (keeps many tiny chunks from changing the speed every second).
- Safeguards: signal ≥ `speedUrgentMs` jumps straight to the target level (`speedWhy=urgent`); after
  the output was idle ≥ `speedResetGapMs`, the level may drop straight to the target (`speedWhy=reset`).
- `maxBacklogMs` drops are unchanged and still the hard cap.

| Context key | Env var | Default | Meaning |
|---|---|---|---|
| `speedMode` | `SPEED_MODE` | `levels` | `levels` = graded levels below; `steps` = revert switch, exactly the previous `speedupSteps` behaviour; `off` = always 100% |
| `speedLevels` | `SPEED_LEVELS` | `100,110,120,130,145` | Rate % of L1..Ln: 2-10 strictly ascending integers 100-200. Cap 145% (calibrated: 150% saves only 2 more points of duration; Japanese above ~140% gets hard to follow) |
| `speedThresholdsMs` | `SPEED_THRESHOLDS_MS` | `3000,4500,6000,7500` | Signal (ms) to enter L2..Ln: exactly levels−1 strictly ascending integers 0-60000 |
| `speedHysteresisMs` | `SPEED_HYSTERESIS_MS` | `1500` | Down-hysteresis; integer 0-10000 |
| `speedHoldMs` | `SPEED_HOLD_MS` | `8000` | Audio ms at the current level before the next change; integer 0-60000 (0 = no hold) |
| `speedUrgentMs` | `SPEED_URGENT_MS` | `10000` | Jump straight up at this signal; integer 0-120000 (0 = never) |
| `speedLookahead` | `SPEED_LOOKAHEAD` | `1` | Weight of the look-ahead term; 0-2 (0 = off) |
| `speedMsPerChar` | `SPEED_MS_PER_CHAR` | `165` | Estimated Japanese ms per spoken char at 100% (calibrated for Kazuha neural); integer 20-1000 |
| `speedResetGapMs` | `SPEED_RESET_GAP_MS` | `3000` | Output idle at least this long: step down straight to the target; integer 0-60000 (0 = never) |

Invalid values fail `cdk synth` with a message (the app also falls back to the defaults with a WARN).
```
# revert to the previous two-phase-like behaviour (speedupSteps per chunk), exactly as before
npx cdk deploy -c venueCidr=<cidr> -c speedMode=steps
# no speed-up at all
npx cdk deploy -c venueCidr=<cidr> -c speedMode=off
# gentler (lower cap, later thresholds) / more aggressive (150% cap, earlier thresholds)
npx cdk deploy -c venueCidr=<cidr> -c speedLevels=100,108,116,124,132 -c speedThresholdsMs=3500,5000,6500,8000
npx cdk deploy -c venueCidr=<cidr> -c speedLevels=100,112,125,137,150 -c speedThresholdsMs=2500,4000,5500,7000
# quicker reaction (shorter hold, the first evaluated setting) / steadier speed / no look-ahead
npx cdk deploy -c venueCidr=<cidr> -c speedHoldMs=4000 -c speedHysteresisMs=1000
npx cdk deploy -c venueCidr=<cidr> -c speedHoldMs=12000
npx cdk deploy -c venueCidr=<cidr> -c speedLookahead=0
```
Log: `SYNTH … level=L rate=R backlogMs=… signalMs=… estMs=… speedWhy=target|slew|hold|hyst|urgent|reset|steps|off …`.

Live diagnostics (`aws logs tail /simul-translation/app --follow --region ap-northeast-1`), one line
per stage, grep by `[chunk N]`:
```
[chunk 12] COMMIT reason=comma words=7 audio=12.34-14.80s commitLagMs=950 queueDepth=1 en="..."
[chunk 13] COMMIT reason=sentence words=10 merged=1 ... en="Yeah. we are building ..."   (merged=N: N short sentences joined into this chunk)
[chunk 14] COMMIT reason=merge_pause|merge_hold ...   (held text released by the pause / max-hold rule)
[chunk 12] SYNTH translateMs=45 synthMs=320 level=2 rate=110 backlogMs=3200 signalMs=3900 estMs=2640 speedWhy=target sinkQueuedMs=0 queueDepth=1 pcmBytes=64000 audioMs=2000 ja="..." fillers="you know,um" enTranslated="..."
[chunk 12] PLAYED writtenBytes=64000 pcmBytes=64000 waitMs=3 e2eFirstWordMs=3900 e2eLastWordMs=2100
[chunk 12] DROPPED reason=backlog backlogMs=10450 capMs=10000 newerQueued=2 en="..."
[chunk 12] SKIPPED reason=filler-only fillers="um" en="Um."
[chunk 12] FAILED stage=translate|synth|play err=...
[verify] result=ab12cd34 items=42 committed=42 OK
[verify] result=cd34ef56 items=2 committed=2 held=2 OK   (held=K: K items still held for merging; committed once, later)
[summary] session=1 committed=N played=N dropped=0 failed=0 synthBytes=X writtenBytes=X ... maxBacklogMs=..
```
When OBS stops/reconnects, the app finishes playing the current audio and listens again
(`[session N] ended`), so there is no task restart.

## OBS configuration

Get the passphrase (stack output `GetSrtPassphraseCommand`):
```
aws secretsmanager get-secret-value --region ap-northeast-1 --secret-id <SrtPassphraseSecretArn> --query SecretString --output text
```
OBS → Settings → Stream: Service `Custom...`, Server (output `ObsSrtUrlTemplate`):
```
srt://<SrtIngestIp1>:9000?mode=caller&latency=120000&pbkeylen=16&passphrase=<passphrase>
```
Stream key: empty (no `streamid` is used by the app). `SrtIngestIp2` works as a backup.
Output: audio-only, MPEG-TS container, Opus audio. Enable Settings → Advanced → Automatically
reconnect. Check that audio arrives:
```
aws logs tail /simul-translation/app --follow --region ap-northeast-1
```

## Listeners

Share the `ListenerUrl` output (a QR code on the slides works well). Attendees open it, tap
Listen, and use headphones. The page fetches `/config.json` (LiveKit URL) and `/token`
(subscribe-only token), then plays the Japanese audio via the LiveKit client SDK.
Networks that block UDP fall back to ICE/TCP 7881. No TURN/TLS-443 relay is configured,
so networks that allow only 443 won't get audio; ask those attendees to use mobile data.

## Polly pronunciation readings
Polly misreads some Latin-script names (MediaPackage, MediaConnect, AVC, HEVC, SCTE-35, ...). With
`pollyReadings=on` (default) the app wraps known terms from the generated `polly-readings.csv` of your dictionary folder
in SSML `<sub alias="katakana">TERM</sub>` just before Polly. The product name is never altered in text: the term stays unchanged as the `<sub>` element text and in every log, context and validator; only the alias changes how Polly pronounces it.
| Context key | App env var | Default | Meaning |
|---|---|---|---|
| `pollyReadings` | `POLLY_READINGS` | `on` | `on` or `off` (revert switch: Polly input identical to before) |
The readings file ships in the image (`POLLY_READINGS_FILE` defaults to `/app/assets/polly-readings.csv`; not a CDK key).
No IAM change. To add or change a reading: edit `terms.csv`, run `node ../dictionaries/build.mjs generate`, redeploy.
```
npx cdk deploy -c venueCidr=<cidr> -c pollyReadings=off   # revert
```
Log: `SYNTH ... readings=N ...` (N = terms substituted in that chunk; `ja="..."` stays the original text) and a startup line `pollyReadings=on file=... entries=80`.
## Dictionaries

Source file: `terms.csv` in your dictionary folder (`dictionaries/local/`, else `dictionaries/example/`, or the
folder named by `dictionaryDir`). `node ../dictionaries/build.mjs generate` writes `transcribe-vocabulary.txt`
(Phrase/SoundsLike/DisplayAs, tab-separated) and `translate-terminology.csv` (`en,ja`) from it; do not edit them by
hand. To update, regenerate and run:
```
./scripts/dictionaries.sh --dry-run        # prints the folder used, the S3 key, sizes and sha256; no AWS call
./scripts/dictionaries.sh --restart-app
```
The stack also copies the folder's `polly-readings.csv` into the app image (a Docker build context named
`dictionary`, hashed into the image asset), so `cdk synth` and `cdk deploy` need the generated files to exist.
The script creates a private bucket `simul-translation-dict-<account>-<region>` (Block Public
Access on), uploads the vocabulary, creates/updates the Transcribe vocabulary and waits for
`READY`, imports the terminology (OVERWRITE), and with `--restart-app` forces a new ECS
deployment. Names default to `simul-translation` (override with `DICT_NAME`, and pass the same
names via `-c transcribeVocabularyName=... -c translateTerminologyName=...`). These are managed
by script rather than CloudFormation because vocabulary creation is asynchronous.

## TLS for LiveKit

Default: Caddy obtains a Let's Encrypt certificate for `<LiveKitPublicIp>.sslip.io` via
TLS-ALPN-01 on 443 (port 80 is never opened). No domain needed.

Alternative (own domain / Route53): create an A record (e.g. `live.example.com`) pointing at
the `LiveKitPublicIp` output, then redeploy with `-c livekitHostname=live.example.com`.
Use this if Let's Encrypt's limit of 5 duplicate certificates per week for the same name is hit
(each instance replacement requests a new cert).

## Operations

- Shell on the SFU host (no SSH; SSM Session Manager):
  `aws ssm start-session --target <LiveKitInstanceId> --region ap-northeast-1`
- If OBS disconnects, the app exits and ECS starts a new task (about 1–2 minutes including
  NLB registration). Keep OBS connected through the session and keep auto-reconnect on.
- The publisher uses a fixed LiveKit identity, so the service runs one task at a time
  (deployments stop the old task before starting the new one, a brief gap). Don't redeploy
  during the session.
- Keep a human interpreter or the original audio as a fallback.

## Intentional public exposure

- Listener page and `GET /token` via CloudFront: anonymous by design (attendees on phones).
  The Lambda only issues tokens for the configured room with `canSubscribe: true`,
  `canPublish: false`, `canPublishData: false`; no request input changes the grant.
  Worst case for abuse is someone else listening to the translated audio.
- LiveKit SFU: TCP 443 (WSS signaling, Caddy), TCP 7881 and UDP 50000–60000 (WebRTC media)
  open to `0.0.0.0/0`, as required for browsers. LiveKit's plain listener (7880) is bound to
  127.0.0.1 and not in the security group.
- Not public: SRT UDP 9000 accepts only `venueCidr`; app health port 8080 only from the NLB
  security group; S3 bucket is private (OAC, Block Public Access); the token function URL
  requires IAM auth (only CloudFront can call it); no SSH or port 80 anywhere.

## Teardown

```
npx cdk destroy -c venueCidr=203.0.113.10/32
```
Secrets go into scheduled deletion (default 30 days). Remove the dictionaries manually:
```
aws transcribe delete-vocabulary --vocabulary-name simul-translation --region ap-northeast-1
aws translate delete-terminology --name simul-translation --region ap-northeast-1
aws s3 rb s3://simul-translation-dict-<ACCOUNT_ID>-ap-northeast-1 --force --region ap-northeast-1
```
