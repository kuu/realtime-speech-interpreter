# Configuration

There are three ways to set things, from simple to detailed:

1. **`cdk/config/event.json`**: about a dozen settings per event. Start here.
2. **A profile**: a named bundle of timing settings (`talk`, `careful`, `qa`).
3. **Any CDK context key** with `-c key=value` (about 100, listed in [Advanced keys](#advanced-keys)).

All settings are applied when you run `cdk synth/deploy`. Changing one needs a deploy (about 2-3 minutes for app settings).

## Quick start

```bash
cd cdk
cp config/event.example.json config/event.json   # event.json is gitignored
$EDITOR config/event.json                        # at least venueCidr
../scripts/doctor.sh                             # checks your machine and AWS account
npx cdk deploy                                   # no -c flags needed
```

## Precedence

Highest wins:

| # | Source | Example |
|---|---|---|
| 1 | Explicit `-c` flag | `-c chunkMinWords=7` |
| 2 | `cdk/config/event.json` | `"profile": "talk"` or `"advanced": {"chunkMinWords": 6}` |
| 3 | Profile (`-c latencyPreset=<name>` or event `profile`) | `config/profiles/talk.json` |
| 4 | `cdk/cdk.json` `context` | shipped defaults |

"Explicit" means a `-c` value that differs from the value in `cdk.json`. A `-c` flag that repeats the `cdk.json` default is indistinguishable from no flag, so `event.json` or the profile still applies. To force such a value, put it in `event.json` under `"advanced"`. To ignore `event.json` for one run, pass `-c eventFile=none`; to use another file, `-c eventFile=path/to/other.json`.

The order is tested in `cdk/test/config.test.ts`. Old flags keep working: every key of `cdk.json` is still read by `cdk/lib/config.ts`, and `-c venueCidr=... -c translateEngine=llm -c latencyPreset=fast` produces the same container environment, IAM policies and security groups as before layered configuration existed (`cdk/test/parity.test.ts`, golden files in `cdk/test/fixtures/`).

## event.json

Plain JSON. Comments (`//` and `/* */`) are accepted by the loader, so you can annotate your own copy. The example file has none so that editors treat it as valid JSON.

| Key | Type | Example | Maps to | Meaning |
|---|---|---|---|---|
| `venueCidr` | string or list | `["203.0.113.10/32"]` | `venueCidr` | Public egress IP(s) of the venue network, as `/32` or small CIDR. Only these addresses may send SRT and reach the health check. Required. `0.0.0.0/0` is rejected. Find it from the venue network with `curl https://checkip.amazonaws.com`. |
| `region` | string | `"ap-northeast-1"` | `region` | AWS Region of the whole stack. |
| `profile` | string | `"talk"` | `latencyPreset` | Latency profile, see [Profiles](#profiles). |
| `sourceLanguage` | string | `"en-US"` | `sourceLanguage`, `translateSource` | Transcribe code of the speaker's language. Must be in `languageOptions` (advanced, default `en-US,ja-JP`). `translateSource` is its prefix (`en`). |
| `targetLanguage` | string | `"ja"` | `translateTarget` | Translate code of the listeners' language. The Polly voice must speak it. |
| `pollyVoice` | string | `"Kazuha"` | `pollyVoice` | Polly voice for the target language. |
| `channels` | list of 1 or 2 lanes | `[{"source":"en-US","target":"ja","pollyVoice":"Kazuha"},{"source":"ja-JP","target":"en","pollyVoice":"Joanna","transcribeVocabulary":"simul-translation-ja","translateTerminology":"simul-translation-ja-en"}]` | `channels` (event key only; `-c channels='<json>'` overrides it) | Output channels, see [bilingual-channels.md](bilingual-channels.md). Absent = one English-to-Japanese channel from the flat keys (today). Per lane: `source` (Transcribe code, in `languageOptions`), `target` (Translate code and channel id), `pollyVoice` (required), `transcribeVocabulary`, `translateTerminology` (a lane other than English to Japanese defaults them to `""`), `translateEngine` (optional). Replaces `sourceLanguage`, `targetLanguage` and `pollyVoice`: combining them with `channels` is rejected. Two lanes need `languageFilter=langid` and add the `CHANNELS` variable, the `ListenerUrl<Id>` output and the channel list in `config.json`; one lane uses the flat variables. |
| `pollyReadings` | true/false | `true` | `pollyReadings` | `true` = apply the pronunciation readings (SSML `sub` aliases) from the generated `polly-readings.csv` of your dictionary folder (see `dictionaryDir`). The displayed text is never changed. |
| `translateEngine` | string | `"llm"` | `translateEngine` | `translate` = Amazon Translate. `llm` = Bedrock model per chunk, Translate stays as fallback. |
| `llmModelId` | string | `"jp.anthropic.claude-haiku-4-5-20251001-v1:0"` | `llmModelId` | Bedrock Japan cross-Region inference profile id (must start with `jp.`). Used only with `translateEngine=llm`. |
| `dictionaries.dir` | string | `"../my-dictionaries"` | `dictionaryDir` | Folder with your dictionary (`terms.csv` and the three generated files). Empty or unset = `dictionaries/local/` if it exists, else `dictionaries/example/`. A relative path is relative to the repository root; absolute paths are recommended. A set but missing folder is an error. Its `polly-readings.csv` is copied into the app image; `dictionaries.sh` uploads the other two. See [dictionaries](dictionaries.md). |
| `dictionaries.transcribeVocabulary` | string | `"simul-translation"` | `transcribeVocabularyName` | Name of the Transcribe custom vocabulary. `""` = none. |
| `dictionaries.translateTerminology` | string | `"simul-translation"` | `translateTerminologyName` | Name of the Translate terminology. `""` = none (not allowed with the LLM engine, which reads its glossary from it). |
| `expectedListeners` | integer | `200` | `livekitInstanceType` | Capacity hint. 1-300: `c6i.large`, up to 1000: `c6i.xlarge`, up to 3000: `c6i.2xlarge`. **This is an estimate, not a load test result**; the audio track is small, but check CPU and network in CloudWatch during a rehearsal. Above 3000 is rejected (one LiveKit node). |
| `advanced` | object | `{"chunkMinWords": 6}` | any key below | Any key of [Advanced keys](#advanced-keys). Unknown names are rejected. |

Unknown top-level keys are rejected with the list of allowed ones, so a typo cannot be silently ignored.

### Two channels: example
```json
{
  "venueCidr": ["203.0.113.10/32"],
  "profile": "fast",
  "channels": [
    { "source": "en-US", "target": "ja", "pollyVoice": "Kazuha" },
    { "source": "ja-JP", "target": "en", "pollyVoice": "Joanna",
      "transcribeVocabulary": "simul-translation-ja", "translateTerminology": "simul-translation-ja-en" }
  ]
}
```
The first channel is the default one: its listener URL has no parameter and it keeps the names `publisher-app`, `translation-audio` and
`captions`. The second channel's page is `?ch=en`. Do not combine `channels` with `sourceLanguage`, `targetLanguage` or `pollyVoice`. A channel
other than English to Japanese defaults its vocabulary and terminology to empty; with the LLM engine every such channel needs a
`translateTerminology`. `synth` prints a warning when the dictionary folder has `transcribe-vocabulary-ja.txt` and the Japanese channel
has no vocabulary. A single channel (for example only `ja-JP` to `en`) is allowed and uses the flat variables.

## Profiles

Profiles live in `cdk/config/profiles/<name>.json` (`description`, `status`, `context`). Every key in `context` must be a `cdk.json` key. Choose one with `"profile"` in `event.json` or `-c latencyPreset=<name>`.

| Profile | Use for | What it sets |
|---|---|---|
| `talk` | One speaker, presentation. | Start of each sentence's Japanese 0.6 to 1.5 s above the measured floor; against `careful` the median start lag fell by 1.2 to 3.4 s on three recorded talks (p90 by 2.6 to 3.5 s). First chunk after 5 words or 2.5 s, no merging of short sentences, shorter pause holds, dynamic language-ID settle, LLM timeout 1.2 s, **`translateEngine=llm`**. About 1.7 times as many, shorter chunks. |
| `careful` | Quality over speed. | Nothing: the `cdk.json` defaults (Amazon Translate, longer chunks). |
| `qa` | Q&A with several languages and speakers. | **Placeholder, not implemented.** Behaves like `careful` today. |
| `fast` | Old name, still accepted. | The `talk` timing settings **without** switching the engine (what `latencyPreset=fast` always did). |
| `default` | Old name, still accepted. | Same as `careful`. |

Why `talk` switches the LLM engine on: the timing bundle was tuned and measured with it, and on a judged sample of 56 chunks Haiku 4.5 scored about 4.1 of 5 against 3.0 for Amazon Translate. The cost was about $1.17 against $1.06 per 4-hour session at list price, plus about 0.6 s per chunk (both from the project's own benchmark; numbers depend on your speech). The scores come from AI judges, not native listeners; please listen to your own material. If you want `talk` timing with Amazon Translate, use `"translateEngine": "translate"` in `event.json` or the profile `fast`.

## Preflight check

`scripts/doctor.sh` (or `npm run doctor` in `cdk/`) checks Node/npm, AWS CLI v2, your identity and Region (never secrets), CDK bootstrap, Docker, ffmpeg with SRT and Opus, the venue CIDR, the Transcribe vocabulary and Translate terminology, and, with `translateEngine=llm`, Bedrock. It prints PASS, WARN or FAIL with the exact fix command and exits 1 on any FAIL. It accepts the same `-c key=value` flags as `cdk`, and `--skip-aws` to run only the local checks. It only reads; it never changes AWS.

## Advanced keys

Every key of `cdk/cdk.json` `context` is listed here. A test (`cdk/test/docs.test.ts`) fails when a key read by `cdk/lib/config.ts` or present in `cdk.json` is missing from this file, or when this file lists a key that no longer exists. Defaults are the `cdk.json` values; `talk` and `fast` override some of them (see [Profiles](#profiles)).

Extra context keys that are not in `cdk.json`:

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `venueCidr` | - | none (required) | Venue egress CIDR(s), comma separated. Event key `venueCidr`. |
| `eventFile` | - | `config/event.json` | Path of the event file (relative to `cdk/`), or `none` to ignore it. |

### Stack

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `region` | `AWS_REGION` | `ap-northeast-1` | AWS Region of the stack. Also read by `bin/simul-translation.ts` (same layers as every key). The LLM engine needs a Region that has the `jp.` inference profile (Tokyo/Osaka). |
| `appPath` | - | `../app` | Path of the app source (Docker build context, web assets) relative to `cdk/`. Change only if you move the folders. |
| `latencyPreset` | LATENCY_PRESET (log only) | `default` | Profile / preset name: `talk`, `careful`, `qa` or the old `fast`, `default`. See Profiles. Event key `profile`. |
| `logLevel` | `LOG_LEVEL` | `info` | App log level: `debug`, `info`, `warn`, `error`. |
| `logRetentionDays` | - | `14` | CloudWatch Logs retention in days (a value CDK accepts, e.g. 7, 14, 30). |
| `taskCpu` | - | `1024` | Fargate task CPU units (1024 = 1 vCPU). |
| `taskMemoryMiB` | - | `2048` | Fargate task memory (MiB). Must be a valid combination with `taskCpu`. |
| `desiredCount` | - | `1` | Number of app tasks. Keep 1: the design has one app task publishing the audio. |

### SRT ingest

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `srtPort` | `SRT_PORT` | `9000` | SRT listener port on the NLB and in the container (UDP). Must differ from `healthPort`. |
| `srtLatencyMs` | `SRT_LATENCY_MS` | `120` | SRT receive buffer. Higher = more loss resilience on a bad venue network, more delay. |
| `srtListenTimeoutSec` | `SRT_LISTEN_TIMEOUT_SEC` | `86400` | How long the app waits for OBS to connect (seconds). |
| `srtAnalyzeMs` | `SRT_ANALYZE_MS` | `500` | ffmpeg input probing of the SRT stream (`-analyzeduration`, ms). With ffmpeg's default (~5 s for MPEG-TS) the first ~5 s of every SRT connection are held and then released at once; the language-ID Transcribe stream (`languageFilter=langid`) keeps that burst as a permanent lag for the whole session (measured: +5.1 s on every chunk). 500 ms: first PCM after 0.4-0.9 s instead of 4.9-5.4 s, Opus and AAC senders, Homebrew ffmpeg and the image's ffmpeg 5.1. Each stream logs `startBurstMs=` (expected < 1000). `0` = ffmpeg default (revert); integer 0-10000 |
| `healthPort` | `HEALTH_PORT` | `8080` | HTTP health port for the NLB target check (not exposed to the internet). |
| `sampleRate` | `SAMPLE_RATE` | `16000` | Sample rate of the audio sent to Transcribe (Hz). Keep 16000. |
| `frameBytes` | `FRAME_BYTES` | `3200` | Bytes per frame sent to Transcribe (3200 = 100 ms of 16 kHz mono 16-bit). |

### Speech recognition and language filter

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `sourceLanguage` | `SOURCE_LANGUAGE` | `en-US` | Transcribe language code of the speaker, e.g. `en-US`. Must be one of `languageOptions`. Event key `sourceLanguage` also sets `translateSource` from its prefix. |
| `partialStability` | `PARTIAL_STABILITY` | `high` | Transcribe partial-results stability: `low`, `medium` or `high`. `high` = fewer rewrites of already shown words. |
| `transcribeVocabularyName` | `TRANSCRIBE_VOCABULARY` | `simul-translation` | Name of the Transcribe custom vocabulary. `""` disables it. Created by `cdk/scripts/dictionaries.sh`. Event key `dictionaries.transcribeVocabulary`. |
| `languageFilter` | `LANGUAGE_FILTER` | `langid` | `langid` = drop non-English results; `off` = revert switch, the previous single-language en-US request (Japanese is transcribed as English-looking words and translated, as before) |
| `languageOptions` | `LANGUAGE_OPTIONS` | `en-US,ja-JP` | Languages Transcribe chooses between: 2-5 codes, one per language, must include `sourceLanguage` |
| `langidSettleWords` | `LANGID_SETTLE_WORDS` | `5` | An English result is committed only once it has this many stable words (the language can flip once near the start of a result); integer 1-50. No effect on mid-sentence chunking with `chunkMinWords` ≥ 5 |
| `langidSettleMode` | `LANGID_SETTLE_MODE` | `fixed` | `fixed` = every result needs `langidSettleWords` stable words; `dynamic` = `langidSettleWordsDefault` while no Japanese result was seen in the last `langidJaMemoryMs`, `langidSettleWordsAfterJa` after one, and for a result whose partials shrink before it settles (Transcribe rewriting itself, typical for the first Japanese turn after English). Case-insensitive (`-c latencyPreset=fast -c langidSettleMode=Fixed` turns the preset's dynamic mode back off; the lower-case cdk.json value `fixed` cannot override a preset, see Latency presets) |
| `langidSettleWordsDefault` | `LANGID_SETTLE_WORDS_DEFAULT` | `3` | Dynamic mode: stable words when no Japanese result was seen recently; integer 1-50 |
| `langidSettleWordsAfterJa` | `LANGID_SETTLE_WORDS_AFTER_JA` | `5` | Dynamic mode: stable words within `langidJaMemoryMs` after a Japanese result; integer 1-50 |
| `langidJaMemoryMs` | `LANGID_JA_MEMORY_MS` | `60000` | Dynamic mode: how long after a Japanese result the longer threshold applies; integer 0-600000 |
| `langidSettleItems` | `LANGID_SETTLE_ITEMS` | `5` | Same as `langidSettleWords` for a lane with a Japanese source (`ja-JP`), counted in stable items; read only when a lane has a Japanese source; integer 1-50 |
| `langidSettleItemsDefault` | `LANGID_SETTLE_ITEMS_DEFAULT` | `3` | Dynamic mode, Japanese-source lane: stable items when no English result was seen recently; integer 1-50 |
| `langidSettleItemsAfterEn` | `LANGID_SETTLE_ITEMS_AFTER_EN` | `5` | Dynamic mode, Japanese-source lane: stable items within `langidJaMemoryMs` after an English result; integer 1-50 |
| `langidShortWords` | `LANGID_SHORT_WORDS` | `4` | Also drop an English result of at most this many words with low confidence that comes right after a Japanese one (fragments inside a Japanese passage, e.g. "more.", "sleep."); integer 0-20, `0` disables |
| `langidShortMinConf` | `LANGID_SHORT_MIN_CONF` | `0.6` | Mean word confidence below which that short result is dropped; 0-1 |

### Japanese chunking (a lane with a Japanese source)
Read only when a lane has a Japanese source (`ja-JP`); see [bilingual-channels.md](bilingual-channels.md#japanese-segmenter). The `talk` profile sets `jaClauseMinChars` 8, `jaMaxChars` 30, `jaPauseMs` 600 and `jaMaxWaitMs` 2500.
| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `jaSegmentationMode` | `JA_SEGMENTATION_MODE` | `simple` | `simple` cuts at a stable `。？！`, at every stable `、`, after `jaMaxWaitMs` and on the final. `full` is the opt-in experiment with the dangling test, clause endings, minimum lengths, pause and maximum characters; it can be compared with `simple` in one e2e run. |
| `jaSentenceMinChars` | `JA_SENTENCE_MIN_CHARS` | `6` | A sentence shorter than this is held and joined with the next one, only when `mergeShort` is on; integer 1-200 |
| `jaClauseMinChars` | `JA_CLAUSE_MIN_CHARS` | `12` | `full` only: characters before a `、` cut; integer 1-200 |
| `jaMaxChars` | `JA_MAX_CHARS` | `40` | `full` only: the buffer is cut when it reaches this many characters; integer 4-400 |
| `jaPauseMs` | `JA_PAUSE_MS` | `900` | `full` only: quiet time that cuts the buffer unless it ends on a dangling token; 0 disables |
| `jaMaxWaitMs` | `JA_MAX_WAIT_MS` | `4000` | Both modes: the oldest uncut stable text is cut after this long; 0 disables |
| `jaClauseEndings` | `JA_CLAUSE_ENDINGS` | `""` | `full` only: comma list of clause-closing endings; `""` = the built-in list. Must share no entry with `jaDanglingTokens` |
| `jaDanglingTokens` | `JA_DANGLING_TOKENS` | `""` | `full` only: comma list of tokens a chunk must not end on; `""` = the built-in list |
| `jaDanglingMaxChars` | `JA_DANGLING_MAX_CHARS` | `10` | `full` only: how far back a cut may move to avoid a dangling token; integer 0-100 |
| `jaShortChars` | `JA_SHORT_CHARS` | `4` | A Japanese result of at most this many characters with low confidence right after an English one is dropped; 0 disables |
| `jaShortMinConf` | `JA_SHORT_MIN_CONF` | `0.6` | Mean confidence below which that short result is dropped; 0-1 |
### Chunking (when text is sent to translation)

| Key | Env var in the app | Default | Meaning |
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

### Playback speed and backlog

| Key | Env var in the app | Default | Meaning |
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
| `speedupSteps` | `SPEEDUP_STEPS` | `3000:115,5000:130,7000:150` | Used only with `speedMode=steps` (the previous behaviour): `backlogMs:rate%`, 115% from 3 s backlog, 130% from 5 s, 150% from 7 s. `off` = no speed-up in steps mode |
| `maxBacklogMs` | `MAX_BACKLOG_MS` | `15000` | Latency cap: a queued chunk that would start later than this is dropped whole (oldest first; newest always kept; never cut mid-playback). `0` = never drop. Set `0` with `segmentationMode=sentence` |

### Filler removal and corrections

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `fillerFilter` | `FILLER_FILTER` | `on` | Main switch for filler removal (`off` = translate everything as heard) |
| `fillerWords` | `FILLER_WORDS` | `um,uh,er,ah,hmm,mm,erm,uh-huh` | English filler words, always removed before Translate (whole words) |
| `fillerPhrases` | `FILLER_PHRASES` | `you know,I mean,well,like,sort of,kind of,you see,okay so,so yeah` | Removed only as discourse markers: at chunk/sentence start followed by a comma or nothing, or set off by commas. "do you know", "works well", "I'd like", "this kind of feature" are kept |
| `jaFillerPatterns` | `JA_FILLER_PATTERNS` | `ええと,えーと,えっと,えー,あの,あのー,まあ,ご存知のとおり,ご存知のように,ご存じのとおり,ご存じのように,ほら,つまり、` | Japanese safety net after Translate: stripped (with trailing 、) only at the start or after 。/、 and only when followed by 、/。/end; a pattern ending in 、 only at sentence start |
| `enableCorrection` | `ENABLE_CORRECTION` | `true` | `true`/`false`. Applies the built-in context rules that fix common recognition errors (for example HEBC to HEVC) before translation. |

### Translation

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `translateSource` | `TRANSLATE_SOURCE` | `en` | Amazon Translate source language code, e.g. `en`. Event key `sourceLanguage` sets it. |
| `translateTarget` | `TRANSLATE_TARGET` | `ja` | Amazon Translate target language code, e.g. `ja`. Event key `targetLanguage` sets it. The Polly voice must speak this language. |
| `translateFormality` | `TRANSLATE_FORMALITY` | `FORMAL` | Amazon Translate formality for Japanese (keeps です/ます tone, avoids "慣れてるだろ"). `INFORMAL` or `off` (parameter not sent) = revert |
| `translateTerminologyName` | `TRANSLATE_TERMINOLOGY` | `simul-translation` | Name of the Translate custom terminology (also the glossary of the LLM engine, so it must not be empty with `translateEngine=llm`). `""` disables it. Event key `dictionaries.translateTerminology`. |
| `translateEngine` | `TRANSLATE_ENGINE` | `translate` | `translate` = Amazon Translate only (no Bedrock, no extra IAM). `llm` = Claude on Bedrock with Translate as fallback; adds the IAM statements in [LLM translation engine](#llm-translation-engine-optional) |

### LLM engine (only with translateEngine=llm)

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
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

### Speech output (Polly)

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `pollyVoice` | `POLLY_VOICE` | `Kazuha` | Polly voice name for the target language, e.g. `Kazuha` or `Tomoko` (Japanese neural voices). Event key `pollyVoice`. |
| `pollyEngine` | `POLLY_ENGINE` | `neural` | `neural` or `standard`. |
| `pollySampleRate` | `POLLY_SAMPLE_RATE` | `16000` | Polly output sample rate (Hz). |
| `pollyReadings` | `POLLY_READINGS` | `on` | `on` or `off` (revert switch: Polly input identical to before) |
| `dictionaryDir` | - | `""` (automatic) | Dictionary folder. Empty = `dictionaries/local/` if it exists, else `dictionaries/example/`. Event key `dictionaries.dir`; script env `DICTIONARY_DIR`. Its `polly-readings.csv` is copied into the app image at build time (the app still reads `POLLY_READINGS_FILE`, default `/app/assets/polly-readings.csv` in the image). |
| `captions` | `CAPTIONS` | `on` | `on` = live captions below the Listen button, after a listener presses Listen: Japanese in sync with the voice and the English source line as it is recognised. `off` = no caption data is sent and the page is exactly the page without captions. Not an event-file key: set it with `-c captions=off` or under `advanced`. See [Captions](architecture.md#captions). |
| `captionsJapaneseSpeech` | `CAPTIONS_JA_SPEECH` | `on` | `on` = Japanese speech (what the language filter classifies as Japanese, for example audience questions) is also shown in the Japanese caption area, as said, untranslated and marked with `―`. Its audio behaviour does not change: it is never translated and never spoken. `off` = exactly the captions without it. Needs `captions=on`. Not an event-file key: set it with `-c captionsJapaneseSpeech=off` or under `advanced`. See [Captions](architecture.md#captions) and [Security](security.md). |

### LiveKit and listeners

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `roomName` | `LIVEKIT_ROOM` | `translation` | LiveKit room name that listeners join. Letters, digits, `_`, `-`. |
| `publisherTokenTtl` | `LIVEKIT_TOKEN_TTL` | `6h` | Lifetime of the app publisher token, e.g. `6h`. Should cover the longest event. |
| `listenerTokenTtlSec` | - | `21600` | Lifetime of a listener token issued by the token endpoint (seconds). 21600 = 6 h. |
| `livekitApiKey` | `LIVEKIT_API_KEY` | `simulkey` | LiveKit API key name. The secret is generated by Secrets Manager. |
| `livekitHostname` | - | `""` | Public DNS name of the LiveKit endpoint. Empty = `<elastic IP>.sslip.io`, so Caddy can get a certificate without your own DNS. Set your own name only if it points to the instance's Elastic IP. |
| `livekitInstanceType` | - | `c6i.large` | EC2 type of the LiveKit server. Event key `expectedListeners` picks one for you (estimate, see below). |
| `livekitImage` | - | `livekit/livekit-server:v1.13.11` | LiveKit server container image (pinned tag). |
| `caddyImage` | - | `caddy:2.11.7` | Caddy container image (TLS termination, pinned tag). |
| `livekitUdpPortStart` | - | `50000` | First UDP port of the WebRTC media range opened to the internet. |
| `livekitUdpPortEnd` | - | `60000` | Last UDP port of that range. Must be >= start. |
| `livekitTcpPort` | - | `7881` | TCP fallback port for WebRTC (ICE/TCP). |

### Browser microphone input

A second input next to SRT: a speaker opens `/publish` in a desktop browser and types the event code. Off by default.
With `inputSource=srt` the synthesized template is the same as without this feature (see the check in
[cdk/README.md](../cdk/README.md)). Design and security model: [security.md](security.md#browser-microphone-input). The event end time is not a
CDK key: the operator command `cdk/scripts/publisher-code.mjs --ends-at <UTC time>` sets it.

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `inputSource` | `INPUT_SOURCE` | `srt` | `srt`, `browser` or `rtmps` ([RTMPS input](#rtmps-input)). Exactly one input runs, never two. `browser` deploys the publisher endpoint, the page and the code secret. Changing it is a deploy. Not an event-file key: set it with `-c inputSource=browser` or under `advanced`. |
| `browserInputConcurrency` | - | `5` | Reserved concurrency of the publisher token function. Integer, at least 1 (0 is rejected). It is the brute-force throttle. A low-quota account may refuse the reservation: raise the Lambda concurrency quota. |
| `browserInputTokenTtlSec` | - | `600` | Lifetime of a publisher token (seconds, 60-3600). Covers the join only. |
| `browserSessionGraceSec` | `INGEST_SESSION_GRACE_SEC` | `60` | A browser session ends when no publisher has been present for this many seconds (10-600). A handover inside this time is one session. |
| `browserAudioProcessing` | - | `all` | **Provisional, to be set after the live measurement.** `all` = echo cancellation, noise suppression and auto gain on (browser default); `echo` = echo cancellation only; `none` = all off. Passed to the page through `config.json`. |
| `browserSilenceDb` | `INGEST_SILENCE_DB` | `-60` | **Provisional, to be set after the live measurement.** Level (dBFS, -120 to 0) below which the input counts as silent in the operator log. |
| `browserSilenceSec` | `INGEST_SILENCE_SEC` | `30` | **Provisional, to be set after the live measurement.** Seconds below the silence level before the app logs a warning (5-600). |

`roomName` must not end in `-ingest`: the browser path uses the separate room `<roomName>-ingest`.

### RTMPS input

A third input for venues whose network blocks outbound UDP: OBS (or ffmpeg) sends RTMPS over TCP 443 to Caddy on the
LiveKit host, which forwards it to the app. Off by default; with `inputSource=srt` or `browser` the template has no RTMPS
resource and Caddy keeps the official image and configuration. Design: [alternative-inputs.md](alternative-inputs.md).
The stream key is generated by Secrets Manager; read it with the `GetRtmpsStreamKeyCommand` output.

| Key | Env var in the app | Default | Meaning |
|---|---|---|---|
| `inputSource` | `INPUT_SOURCE` | `srt` | `rtmps` turns this input on (see the row above for the other values). |
| `rtmpPort` | `RTMP_PORT` | `1935` | Plain RTMP port of the NLB TCP listener and the container (Caddy forwards to it; only the LiveKit Elastic IP may connect). Port 1-65535; must differ from `srtPort`, `healthPort`, `livekitTcpPort`, 443 and 7880. Checked for every `inputSource`. |

Validation with `inputSource=rtmps`: `venueCidr` must be set (Caddy admits only those addresses to the RTMPS route), and
`livekitHostname` must be empty (the RTMPS name `rtmps.<LiveKit IP>.sslip.io` only exists for the sslip.io host).
The app refuses to start without a stream key of 16-128 letters and digits (`RTMP_STREAM_KEY`, set by the stack).
### Not CDK keys

CDK feature flags (`@aws-cdk/...`) in `cdk.json` are CDK settings, not part of this project's configuration.
