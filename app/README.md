# App

Node.js/TypeScript application: SRT ingest → Transcribe → Translate → Polly →
LiveKit publisher. Runs on AWS Fargate; also runnable locally.

```
OBS --SRT/Opus--> ffmpeg(listener) --PCM--> Transcribe --> Translate --> Polly --PCM--> LiveKit --> browsers
```

## Layout

```
src/
  main.ts          entry: wires source → pipeline → LiveKit; health endpoint
  config.ts        all env-driven configuration
  srt-source.ts    SRT listener via ffmpeg (Opus/AAC → PCM)
  pcm-queue.ts     decouple/re-chunk PCM frames
  pipeline.ts      Transcribe streaming session → Segmenter → ChunkPlayer (never awaits downstream)
  segmenter.ts     stable-word commit bookkeeping + clause/sentence cut rules (pure, unit-tested)
  chunk-player.ts  single ordered worker: corrections → engine (Translate | LLM) → Polly → sink
  translate-call.ts   the Amazon Translate call + shared per-call timeout
  translate-engine.ts engines: Translate-only (default) and LLM with per-chunk Translate fallback; warm-up, keep-warm
  bedrock-llm.ts   Bedrock Runtime Converse client (the only file importing the Bedrock SDK)
  llm-prompt.ts    system prompt (benchmarked), request builder, token cap (pure)
  llm-validate.ts  output validation before Polly (pure, unit-tested incl. injection cases)
  llm-breaker.ts   error classification + circuit breaker (pure)
  llm-context.ts   ring buffer of the last chunks played (pure)
  llm-stats.ts     counters, cache hit rate, cost estimate, [llm-summary] (pure)
  glossary.ts      deployed Translate terminology → glossary lines (pure parse + loader)
  audio-sink.ts    sink interface + FileAudioSink (local tests)
  livekit-sink.ts  headless LiveKit publisher (PCM → Opus track)
  corrections.ts   post-recognition correction map
  log.ts           leveled logger
  tools/make-token.ts  LiveKit token generator
  tools/llm-probe.ts   real-API checks of the LLM engine (`npm run probe:llm`, cents)
web/               browser listener page (LiveKit client SDK)
Dockerfile         Node + ffmpeg (libsrt/libopus); used by the Fargate CDK construct
```

## Run locally

Prereqs: Node 18+, ffmpeg (with libsrt/libopus), AWS creds, a LiveKit server.

1. Start a local LiveKit server (native binary avoids Docker/mDNS ICE issues):
   ```
   livekit-server --dev --bind 127.0.0.1
   ```
2. Run the app against a PCM file (no OBS needed):
   ```
   INPUT_FILE=sample.raw \
   TRANSCRIBE_VOCABULARY=simul-translation \
   npm start
   ```
   Or run the live SRT path (omit INPUT_FILE) and point OBS at
   `srt://<host>:9000?mode=caller`.
3. Serve `web/` and open it; get a listener token with:
   ```
   npm run token -- listener subscribe
   ```

## Live microphone test (latency & accuracy)

Speak into your Mac's mic and hear the Japanese translation, to check end-to-end
latency and recognition/translation accuracy. No OBS needed; ffmpeg sends the mic
as SRT.

> ⚠️ **Wear headphones.** Without them the mic picks up the translated audio,
> causing echo/feedback and a wrong latency reading.

Use four terminals.

1. **LiveKit** (native — avoids the Docker/mDNS ICE issue for local browser playback):
   ```
   livekit-server --dev --bind 127.0.0.1
   ```

2. **App** (live SRT path — do NOT set INPUT_FILE):
   ```
   LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
   npm start
   ```
   The app logs each chunk's EN (`COMMIT`) and JA (`SYNTH`) text — that's your accuracy check.
   (Add `TRANSCRIBE_VOCABULARY=<name>` once the custom vocabulary exists.)

3. **Mic → SRT sender** (find your mic index with
   `ffmpeg -f avfoundation -list_devices true -i ""`; built-in mic is usually `:1`):
   ```
   ffmpeg -f avfoundation -i ":1" \
     -ac 1 -ar 48000 -c:a libopus -b:a 64k -f mpegts \
     "srt://127.0.0.1:9000?mode=caller&latency=120"
   ```
   Start this after the app is up.

4. **Listener** (local test page with URL + token inputs):
   ```
   # serve the web/ folder
   python3 -m http.server 8090        # run inside web/
   # in repos/app, mint a subscriber token:
   npm run token -- listener subscribe
   ```
   Open `http://localhost:8090/local-test.html`, paste the token, click Join.

**Measuring latency:** with headphones on, speak a short sentence and time the gap
between finishing it and hearing the Japanese begin. That is the ear-to-ear latency.

## Test without LiveKit (file sink)

```
INPUT_FILE=../../slice-1/sample.raw AUDIO_SINK=file OUTPUT_FILE=/tmp/out.pcm \
TRANSCRIBE_VOCABULARY=simul-translation TRANSLATE_TERMINOLOGY=simul-translation npm start
ffplay -f s16le -ar 16000 -ac 1 /tmp/out.pcm      # listen to the result
npm test                                          # segmenter unit tests
```

The app exits after the file is fully played and prints a `[summary]` line.

## Segmentation and playback

- `SEGMENTATION_MODE=clause` (default): translation starts mid-sentence. Only words Transcribe
  marks stable are committed (each exactly once, tracked per result id by item count); the final
  result commits only the remainder. A chunk is cut at `.?!`; at `,;:` or before a conjunction
  (`CHUNK_CONJUNCTIONS`) once `CHUNK_MIN_WORDS` words have accumulated; at `CHUNK_MAX_WORDS`; after
  `CHUNK_MAX_MS`; after `CHUNK_PAUSE_MS` of transcript silence; and at each final result.
- Merging short sentences (`MERGE_SHORT=on`, default; clause mode only): a sentence end or final
  that would give a chunk with fewer than `SENTENCE_MIN_WORDS` (default 8, fillers excluded) words is
  not cut. The text is held and joins the following text, across Transcribe results; internal periods
  stay in the text ("Yeah. we are building …"). Held text is committed at the next boundary once the
  combined text has `SENTENCE_MIN_WORDS` words, by a comma/conjunction/`CHUNK_MAX_WORDS` cut, after
  `MERGE_PAUSE_MS` (default 1500) of transcript silence (`reason=merge_pause`; while text is held this
  replaces `CHUNK_PAUSE_MS`), once its oldest word is `MERGE_MAX_HOLD_MS` old (default 6000, safety
  valve, `reason=merge_hold`), and at end of stream/session/error. A period followed by a lowercase
  word in the same stable batch is treated as a false sentence end (no cut). A chunk that contains
  held text logs `merged=N` (number of suppressed boundaries) on its `COMMIT` line, and `[verify]`
  shows `held=K` when K of the final's items were still held at verify time. `MERGE_SHORT=off`
  restores the previous cutting exactly.
  Complete sentences are not held (`SENTENCE_COMPLETE_WORDS`, default 5): a `.?!` that ends a sentence
  of at least that many words (fillers excluded, counted from the previous `.?!`; a Transcribe result
  split inside the sentence doesn't restart the count, and words of the same sentence already sent in
  an earlier chunk count too, so the short tail of a long sentence, "… existing services.", isn't held)
  is cut at once with `reason=sentence`, together with any held fragment before it ("I see. We have
  about 10 minutes."). Only fragments ("OK.",
  "Thank you.") still merge. `SENTENCE_COMPLETE_WORDS=0` restores the previous merge behavior exactly.
- Quality v1 (fewer split sentences; each part has its own revert):
  - `DANGLING_GUARD=on` (default, `off` = revert): a chunk never ends on a dangling word (preposition,
    article, "that", "to", ...). Comma/conjunction cuts after such a word are skipped, `CHUNK_MAX_WORDS`
    grows by up to `DANGLING_MAX_WORDS` (default 2, 0-20), and pause/final/merge cuts wait up to
    `DANGLING_MAX_HOLD_MS` (default 500, 0-10000). `DANGLING_WORDS` (default empty = built-in list) is a comma list.
  - `CUT_LOOKAHEAD_MS=0` (default = off; try 300-500 for fewer mid-sentence splits at ~+0.5 s latency, 0-5000): a mid-sentence pause/final cut waits this long for the next word.
  - `SHORT_SENTENCE_JOIN=on` (default, `off` = revert): held sentences of at most `SHORT_SENTENCE_WORDS`
    (default 3, 1-6) words wait `SHORT_JOIN_PAUSE_MS` (default 1000, 0 = `MERGE_PAUSE_MS`) and are sent to Translate
    comma-joined ("There's small, medium, and large."); tokens used by `[verify]` are not changed.
  - `TRANSLATE_ENGINE=translate` (default; `llm` = Bedrock LLM with Translate fallback, see "LLM translation engine" below).
  - `TRANSLATE_FORMALITY=FORMAL` (default; `INFORMAL` or `off` = revert): Translate formality setting.
- SRT input probing (`SRT_ANALYZE_MS`, default 500): ffmpeg's default probing (~5 s for MPEG-TS) holds
  the first seconds of every SRT connection and releases them at once. A plain en-US Transcribe stream
  catches up after that burst, but the language-ID stream (`LANGUAGE_FILTER=langid`) keeps it as a
  permanent lag for the whole session (+5 s on every chunk in the cloud). The app passes
  `-analyzeduration` to the listener ffmpeg; `0` = ffmpeg default (revert). Each Transcribe stream
  logs `[session S] stream A startBurstMs=N fedMs=M` (first frame's arrival minus the stream's t0 estimate,
  logged after 30 s of audio or at stream end); expect < 1000 with the default, ~5000 with `0`.
- Local `INPUT_FILE` pacing (`INPUT_PACING`, default `absolute`): frame k is sent at start + k × 100 ms.
  `sleep` is the old per-frame `sleep(100)`, which drifts ~1 % (+2.5 s after 4 min) and inflates local
  commitLag/e2e over a clip. Not used on the SRT path.
- `SEGMENTATION_MODE=sentence`: revert to whole-sentence translation (higher latency). Set
  `MAX_BACKLOG_MS=0` with it: whole sentences are long, so the default 10 s cap drops entire
  sentences under sustained speech. Full revert to the previous behaviour:
  `SEGMENTATION_MODE=sentence MAX_BACKLOG_MS=0 SPEED_MODE=off FILLER_FILTER=off`.
- Playback: one worker translates, synthesizes and plays chunks strictly in order. `backlogMs` =
  how late a chunk's Japanese would start relative to its last English word, measured at synth time.
  Polly speed (`src/speed-control.ts`, chosen right before the Polly call, so no added delay):
  - `SPEED_MODE=levels` (default): graded levels `SPEED_LEVELS` (default `100,110,120,130,145` = L1-L5).
    The decision signal is `backlogMs + SPEED_LOOKAHEAD × max(0, estJaMs − enSpanMs)`, where
    `estJaMs = SPEED_MS_PER_CHAR` (165, calibrated for Kazuha) × spoken Japanese characters, so a long
    Japanese chunk for a short English chunk is sped up before it creates backlog (no extra Polly call).
    `SPEED_THRESHOLDS_MS` (default `3000,4500,6000,7500`) = signal needed to enter L2..L5. Smoothing:
    at most ±1 level per chunk; going down needs the signal `SPEED_HYSTERESIS_MS` (1500) below the
    threshold; no change until `SPEED_HOLD_MS` (8000) of audio has played at the current level.
    Safeguards: signal ≥ `SPEED_URGENT_MS` (10000, 0 = off) jumps straight up; after the output was
    idle ≥ `SPEED_RESET_GAP_MS` (3000, 0 = off) the level may drop straight to the target.
  - `SPEED_MODE=steps`: revert switch, exactly the previous behaviour: `SPEEDUP_STEPS` (default
    `3000:115,5000:130,7000:150`: 115% from 3 s, 130% from 5 s, 150% from 7 s) per chunk from the
    instantaneous backlog. `SPEEDUP_STEPS` is used only in this mode.
  - `SPEED_MODE=off`: always 100%.
  Rates are integers 100-200 (Polly accepts 20-200%); 100% is sent as plain text, others as
  `<speak><prosody rate="N%">` with the text XML-escaped, falling back to plain text if Polly rejects
  the SSML. Hard cap `MAX_BACKLOG_MS` (default
  10000; 0 disables): a queued chunk that would start later than the cap is dropped whole before it
  starts (`[chunk N] DROPPED reason=backlog`), oldest first; the newest chunk is always kept and a
  chunk that started playing is never cut. Translate/Polly failures skip only that chunk (`FAILED`).
- Fillers (`FILLER_FILTER=on`, default): `FILLER_WORDS` (um, uh, ...) are removed before Translate;
  `FILLER_PHRASES` (you know, I mean, well, like, ...) only when used as discourse markers (chunk/
  sentence start + comma or nothing, or between commas), so "do you know" / "works well" / "I'd like"
  survive. `JA_FILLER_PATTERNS` strips ええと / ご存知のとおり etc. from the Japanese at the start or after
  。/、 when followed by 、/。/end. A filler-only chunk is skipped (`SKIPPED`), no Translate/Polly call.
- When the SRT sender disconnects the app keeps running and listens again (`[session N] ended`).
- Language filter (`LANGUAGE_FILTER=langid`, default): Transcribe runs with multi-language
  identification (`LANGUAGE_OPTIONS`, default `en-US,ja-JP`; `PreferredLanguage=SOURCE_LANGUAGE`; the
  vocabulary goes in `VocabularyNames`). `src/language-gate.ts` forwards to the segmenter only results
  tagged `SOURCE_LANGUAGE`, so Japanese speech (moderator, audience questions) is never translated or
  spoken. An English result is committed once it has `LANGID_SETTLE_WORDS` (5) stable words (the
  language can flip once near the start of a result). `LANGID_SETTLE_MODE=dynamic` replaces the fixed
  threshold: `LANGID_SETTLE_WORDS_DEFAULT` (3) stable words while no non-English result was seen in the
  last `LANGID_JA_MEMORY_MS` (60000), `LANGID_SETTLE_WORDS_AFTER_JA` (5) after one (a result that starts
  as Japanese and flips to English counts too, and so does a result whose partials shrank before it settled). `fixed` (default) is the previous behaviour. A final of at most `LANGID_SHORT_WORDS` (4) words
  with mean confidence below `LANGID_SHORT_MIN_CONF` (0.6) right after a Japanese final is also dropped.
  Log lines: `[langfilter] dropped result=… reason=non-english|short-low-conf|non-english-late|non-english-eof lang=… words=… conf=… audio=…s lagMs=… text="…"`,
  `[langfilter] stream=N results=… kept=… dropped=… droppedWords=… late=…`, and `[verify] … LANGDROP`
  when a result already committed turns out to be Japanese (its un-spoken words are removed).
  With language ID, Transcribe often closes a result with fewer items than it had marked stable
  and re-transcribes the rest in the next result; the gate never forwards audio that was already
  committed (item-time high-water mark), so those words are not spoken twice (`[langfilter] carry …`).
  `LANGUAGE_FILTER=off` restores the previous single-language request exactly. There is no
  confidence-only mode: partial results carry no confidence, so it could decide only at the end of a
  result (seconds of added latency), and the confidence margin was thin.
- `HEALTH_HOST` (default `127.0.0.1`): bind address of the health endpoint. The Fargate task sets
  `HEALTH_HOST=0.0.0.0` explicitly (the NLB health check needs it); local runs stay on loopback.
- `SRT_HOST` (default `127.0.0.1`): bind address of the SRT listener. Local runs (the mic test above)
  listen on loopback only; the Fargate task sets `SRT_HOST=0.0.0.0` explicitly (awsvpc, the security
  groups restrict the senders). Set `SRT_HOST=0.0.0.0` locally only if a sender on another machine must
  connect, and use `SRT_PASSPHRASE` then.

Per-chunk log lines (grep `[chunk N]`): `COMMIT` (reason, words, merged, audio times, commitLagMs, queueDepth,
en), `SYNTH` (translateMs, synthMs, level, rate, backlogMs, signalMs, estMs, speedWhy =
target|slew|hold|hyst|urgent|reset|steps|off, sinkQueuedMs, queueDepth, engine=translate|llm|fallback (+ LLM fields), pcmBytes, audioMs, ja), `PLAYED` (writtenBytes vs
pcmBytes, e2eFirstWordMs/e2eLastWordMs = when the Japanese starts playing relative to the first/last
English word), `DROPPED` (backlog cap), `SKIPPED` (filler-only), `FAILED`. Plus `[verify]` per Transcribe final (OK / MISMATCH) and `[summary]`.

## LLM translation engine (optional, off by default)

`TRANSLATE_ENGINE=translate` (default) calls Amazon Translate exactly as before; no Bedrock client is
created and no Bedrock SDK code is loaded. `TRANSLATE_ENGINE=llm` translates each chunk with Claude Haiku 4.5
on Amazon Bedrock (Converse API, Japan cross-region profile `jp.anthropic.claude-haiku-4-5-20251001-v1:0`)
and **always keeps Translate as the per-chunk fallback**. Corrections and the English filler filter run
before the engine, the Japanese filler safety net runs after it, for both engines. Segmentation, language
gate and speed control are unchanged.

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `TRANSLATE_ENGINE` | `translate` | `translate`, `llm` | Engine switch. Revert = `translate` (or unset). |
| `LLM_MODEL_ID` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | non-empty | Inference profile. Bare model IDs fail; the CDK IAM scoping only supports `jp.` profiles. |
| `LLM_TIMEOUT_MS` | `1500` | 200-10000 | Per-call limit (AbortSignal plus a race). Benchmark warm Converse: median 667, p90 795, max 2522 ms. |
| `LLM_CONTEXT_CHUNKS` | `3` | 0-6 | Previous chunks (English sent + Japanese spoken) given as context. 0 = none. |
| `LLM_CONTEXT_RESET_MS` | `60000` | 0-600000 | Context is cleared after this much silence in source time, and at a new session. 0 = never on silence. |
| `LLM_GLOSSARY` | `full` | `full`, `off` | `full` puts all glossary entries in the cached system prompt. `off` sends none and no cache point (Haiku 4.5 caches only prefixes of 4096 tokens or more). |
| `LLM_MAX_TOKENS` | `400` | 48-1000 | Ceiling of `clamp(4 x English words, 48, cap)`. `stopReason=max_tokens` is rejected (`truncated`). |
| `LLM_BREAKER_MS` | `30000` | 1000-600000 | Circuit breaker open time (Translate only), then one trial call. |
| `LLM_SKIP_BACKLOG_MS` | `0` (off) | 0-60000 | When the projected playback backlog of a chunk exceeds this, that chunk uses Translate to catch up. Off by default: it trades quality for latency only when the speaker is already ahead of playback. |
| `LLM_PARALLEL_FALLBACK` | `off` | `off`, `on` | `on` starts Translate at the same time as the LLM call and uses it when the LLM fails or is late (about $1 more per 4 h session). |
| `LLM_MAX_CHARS_PER_WORD` | `15` | 4-40 | Validation upper bound: `ceil(value x words) + 10` Japanese characters. Observed Haiku maximum is 14. |
| `LLM_KEEPWARM_MS` | `240000` | 0 or 30000-290000 | A dummy call is sent when no LLM call happened for this long (prompt cache lives 5 min). 0 = off. |
| `LLM_PROMPT_VERSION` | `2` | 1 or 2 | `2` adds `<chunk_ends_sentence>yes|no</chunk_ends_sentence>` to each request (the app sets it from the chunk's final `.?!`) so a chunk cut mid-sentence is translated as an open fragment; `1` = the previous prompt. |
| `LATENCY_PRESET` | `default` | text | Informational only: the CDK `latencyPreset` the task was deployed with; echoed in the startup log. The preset itself is applied at synth time. |

Invalid values fall back to the default with a `WARN [config]` line, like every other setting.

**Glossary (decision: fetch the deployed terminology at startup).** The engine calls
`translate:GetTerminology` for `TRANSLATE_TERMINOLOGY` (CSV), downloads the returned presigned S3 URL
(Node `fetch`, no S3 permission needed) and builds the prompt glossary from it. One source of truth: the
Translate fallback uses the same terminology, and `repos/dictionaries/dictionaries.sh` stays the single
publish step. The glossary is loaded once at start, so restart the task after publishing (`dictionaries.sh
--restart-app` does that). If it cannot be loaded (API error, no terminology name, empty CSV, 10 s timeout)
the engine is disabled for the whole session: an `ERROR LLM ENGINE DISABLED ...` line is logged at start and
every chunk goes to Translate with `fallbackReason=glossary-unavailable`. It never runs without a glossary
silently (`LLM_GLOSSARY=off` is the explicit opt-out).

**Prompt cache and cost.** The system prompt plus glossary (about 5.2k tokens) is cached with a Converse
`cachePoint`. At start the engine sends one warm-up call (TLS connection and cache) and a keep-warm call
whenever the cache is about to expire. A cache miss on every call costs about $7.6 per 4 h session instead
of about $1.2, so a `WARN [llm] cache hit rate low ...` line appears (at most once per 60 s) when fewer than
80 % of the last 20 calls read the cache. Prices in `[llm-summary] estUsd` are Haiku 4.5 list prices
(the `jp.` profile premium of about 10 % is not included).

**Failure behavior.** Every failure falls back to Translate for that chunk and never stalls playback:

| Failure | `fallbackReason` | Breaker |
|---|---|---|
| timeout / abort | `timeout` | opens after 3 in a row |
| `ThrottlingException`, `TooManyRequestsException` | `throttled` | opens at once |
| `ModelNotReadyException` | `model-not-ready` | opens at once |
| `AccessDeniedException`, `UnrecognizedClientException`, `ExpiredTokenException` | `access` | opens at once |
| `ValidationException`, `ResourceNotFoundException` (bad model id) | `bad-request` | opens at once |
| network errors (`ECONNRESET`, `ENOTFOUND`, ...) | `network` | opens after 3 in a row |
| `ServiceUnavailableException`, `InternalServerException`, `ModelErrorException` | `server-error` | opens after 3 in a row |
| anything else | `unknown` | opens after 3 in a row |
| empty output / `stopReason=max_tokens` / other stop reason | `empty` / `truncated` / `validation-stop-reason` | opens after 5 in a row |
| output rejected by validation | `validation-<rule>` | opens after 5 in a row |
| breaker open | `breaker-open` (no Bedrock call) | after `LLM_BREAKER_MS` one trial call |
| backlog above `LLM_SKIP_BACKLOG_MS` | `skip-backlog` | no effect |
| glossary not loaded | `glossary-unavailable` | n/a |

Validation rules (in order, first failure wins; `validation-<rule>`): `multiline` (inner newline),
`tag` (`<...>`), `prefix` (`翻訳:`, `JA:`, `Translation:`, or an English opener such as `Here is`, `Sorry`,
`I appreciate`), `markdown`, `not-japanese` (less than 70 % Japanese letters, or a Latin-only output that is
not a name/acronym), `english-run` (3 or more consecutive English words not in the source or glossary),
`too-short` / `too-long` (character count outside `[max(1, floor(0.4 x words)), ceil(LLM_MAX_CHARS_PER_WORD x
words) + 10]`). Wrapping quotes are stripped. The benchmark showed English meta-text on injection-style
chunks, so validation, not the prompt, is the guard; a Japanese-language refusal cannot be detected by rules.
Only a Translate failure can still fail a chunk (`FAILED stage=translate`, as before).

**Data handling.** With `TRANSLATE_ENGINE=llm` the English transcript text (current chunk plus up to
`LLM_CONTEXT_CHUNKS` previous chunks and the Japanese spoken for them) is sent to Amazon Bedrock through the
Japan cross-region profile, which routes only within Tokyo (`ap-northeast-1`) and Osaka (`ap-northeast-3`). Per the AWS Bedrock
terms, prompts and outputs are not used to train models and are not shared with model providers. Verify that
against the current terms before an event with confidential content. No audio goes to Bedrock.

**Log lines.**
```
  llm engine=llm model=... timeoutMs=1500 contextChunks=3 glossary=full(393) maxTokens=400 breakerMs=30000 skipBacklogMs=0 parallelFallback=off contextResetMs=60000 maxCharsPerWord=15 keepWarmMs=240000   (startup)
  translate engine=llm formality=FORMAL correction=on                                                (startup)
[chunk N] SYNTH ... queueDepth=1 engine=translate pcmBytes=...                                        (default engine: only ` engine=translate` is new)
[chunk N] SYNTH ... queueDepth=1 engine=llm llmMs=642 inTok=148 outTok=24 cacheRead=5143 cacheWrite=0 pcmBytes=...
[chunk N] SYNTH ... queueDepth=1 engine=fallback fallbackReason=timeout llmMs=1500 pcmBytes=...       (llmMs only when an LLM call was made)
WARN [chunk N] LLM_FALLBACK reason=timeout llmMs=1503 detail="..." en="..."
WARN [chunk N] LLM_REJECT rule=english-run detail="..." ja="<first 120 chars>" en="..."
WARN [llm] BREAKER open reason=throttled forMs=30000   |   INFO [llm] BREAKER half-open|closed ...
INFO [llm] warm-up ok ms=550 inTok=38 outTok=15 cacheRead=0 cacheWrite=5186
[llm] cache hit rate low rate=0.40 window=20 inTok=... cacheRead=...
[llm-summary] session=N|exit engine=llm used=412 fallback=7 byReason=timeout:3,validation-tag:2,breaker-open:2 skipBacklog=0 breakerOpened=1 meanLlmMs=655 p90LlmMs=790 maxLlmMs=1500 cacheHitRate=0.99 inTok=.. outTok=.. cacheRead=.. cacheWrite=.. translateCalls=.. estUsd=0.4321
```
`translateMs` keeps its meaning (the whole translate stage, including a failed LLM attempt). `LLM_FALLBACK`
is not logged for the expected reasons `breaker-open`, `skip-backlog` and `glossary-unavailable` (SYNTH and the
BREAKER/startup lines show them). `skip-backlog` is counted as `skipBacklog`, not in `fallback`.

**Check it against the real APIs** (cents; needs AWS credentials for the account): `npm run probe:llm`
(glossary load, cache write then read, three injection chunks, forced timeout, bad model id).
**Revert:** `TRANSLATE_ENGINE=translate` (or unset it; in CDK `-c translateEngine=translate`).

## Configuration

All configurable values are environment variables. The complete, documented set
lives in **`.env.example`** (copy to `.env` for local use); the code source of truth
is `src/config.ts`. Every value has a default, so overrides are only needed to
change behavior.

Secrets (`SRT_PASSPHRASE`, `LIVEKIT_API_SECRET`) come from the environment / AWS
Secrets Manager and are never committed. `.env` is gitignored; `.env.example` is
tracked and contains no real secrets.

## Polly pronunciation readings
`POLLY_READINGS=on|off` (default `on`, case-insensitive; a bad value logs a WARN and uses `on`) and
`POLLY_READINGS_FILE` (default `assets/polly-readings.csv`, bundled in the image). Known Latin terms
(`term,reading` rows) are wrapped as `<sub alias="katakana">TERM</sub>` right before Polly (`src/polly-readings.ts`).
The product name is never altered in text: the term stays unchanged as the `<sub>` element text and in every log, context and validator; only the alias changes how Polly pronounces it.
Matching is case-sensitive, longest term first, and a term must not touch `[A-Za-z0-9]` on either side.
Spelling note: write digit readings in katakana (`ニィ`, not hiragana `にぃ`): with a hiragana alias Polly ends an accent phrase after に (pitch falls, then restarts), which is heard as a pause. Same sounds, no break.
If Polly rejects the SSML the original, unchanged text is sent as plain text (one WARN). A missing
readings file logs a WARN and the app runs without readings. `SYNTH` lines carry `readings=N`; `ja="..."` is
the original text. The speed estimate (`estMs`) is unchanged and still counts the original text. `off` sends exactly what was sent before.
