# Architecture

![Architecture diagram: venue, SRT, Fargate app, AI services (Bedrock default, Translate backup), LiveKit, listener browsers](architecture.drawio.svg)

The diagram shows one channel; with two channels the translation path runs once per direction ([bilingual-channels.md](bilingual-channels.md)).

The diagram is one editable file, [`architecture.drawio.svg`](architecture.drawio.svg). It is a normal SVG with the
draw.io diagram embedded, so GitHub shows it as an image and draw.io opens it for editing. It uses draw.io's AWS
2021+ shapes (`mxgraph.aws4`), which follow the AWS Architecture Icons. See "Edit the diagram" at the end of this page.

## Components

| Component | AWS service or software | What it does | Defined in |
|---|---|---|---|
| Venue encoder | OBS or any SRT encoder | Sends the venue audio as SRT with Opus. | outside the stack |
| SRT entry | Network Load Balancer (UDP 9000) with static Elastic IPs, security groups | Accepts SRT from the venue IP only. | `cdk/lib/simul-translation-stack.ts` |
| App | ECS on Fargate (1 task, ARM64) | Decodes audio, calls the AI services, publishes audio to LiveKit. | `app/src/`, `cdk/lib/` |
| Speech to text | Amazon Transcribe streaming | Text with partial results and per-result language. | `app/src/pipeline.ts` |
| Translation | Amazon Bedrock (Claude Haiku 4.5, the default), with Amazon Translate as the fallback and as the low-cost engine | English to Japanese per chunk. | `app/src/translate-engine.ts`, `app/src/bedrock-llm.ts` |
| Text to speech | Amazon Polly | Japanese speech. Readings for product names. | `app/src/chunk-player.ts`, `app/src/polly-readings.ts` |
| Media server | LiveKit (container) and Caddy (TLS) on one EC2 instance with an Elastic IP | Delivers the audio to browsers over WebRTC. | `cdk/lib/livekit-user-data.ts` |
| Listener page | CloudFront, private S3 bucket | Static page with the LiveKit client. Plays the audio and shows the captions. | `app/web/` |
| Token endpoint | Lambda function URL behind CloudFront (`/token`) | Issues subscribe-only LiveKit tokens. | `cdk/lambda/token/` |
| Publisher page and endpoint (optional) | CloudFront (`/publish`), Lambda function URL (`/publisher-token`) | Speaker page and the publish token for it, only with `inputSource=browser`. | `app/publisher/`, `cdk/lambda/publisher-token/` |
| Secrets | Secrets Manager | LiveKit API key and secret, SRT passphrase, and with browser input the event code. | stack |
| Logs | CloudWatch Logs | `/simul-translation/app`, `/livekit`, `/token`. | stack |

## Data flow

The numbers match the diagram.

| Step | What happens |
|---|---|
| 1 | Audio line out from the mixer goes into OBS (or any SRT encoder). |
| 2 | OBS sends SRT with Opus audio over the internet to the load balancer (UDP, venue IP only). |
| 3 | The load balancer passes it to the Fargate app. ffmpeg decodes it to 16 kHz PCM. |
| 4 | The app streams the audio to Transcribe streaming, with language identification. |
| 5 | Transcribe returns text. The app drops non-English results and cuts chunks. |
| 6 | A Bedrock model (the default) translates each chunk. Amazon Translate is the fallback and the low-cost engine (`translateEngine=translate`). |
| 7 | Polly speaks the Japanese text, with readings for product names. |
| 8 | The app publishes the audio to LiveKit over WebRTC (Opus), and the caption text as data packets. |
| 9 | The listener's browser plays the audio and shows the captions from LiveKit (subscribe only). |
| 10 | The browser loads the page from CloudFront and asks for a token. |
| 11 | CloudFront serves the page from a private S3 bucket. |
| 12 | CloudFront calls the token Lambda, which returns a subscribe-only token. |

With `inputSource=browser`, steps 1 to 3 are replaced: a speaker's browser publishes the microphone to the LiveKit
ingest room (`<roomName>-ingest`), and the app subscribes to that one track (`ingest-room.ts`) and writes 16 kHz PCM
frames into the same `PcmQueue` (`ingest-session.ts`). From the queue on, everything is the same.

**Latency of the browser path.** Real audio goes from the LiveKit `AudioStream` into the queue with no added delay.
The only thing added on the audio path is a silence filler: when no real audio arrived for 100 ms during an open
session, a 100 ms silent frame is pushed, so Transcribe does not stop the stream across a handover. Buffers inside
the browser, the LiveKit jitter buffer and the native `AudioStream` are not controlled by the app. The measured latency
of the browser path against SRT is not known yet; it is on the live-test list in [security.md](security.md#browser-microphone-input).

Inside the app (steps 3 to 8), each stage is a small module:

1. `srt-source.ts` runs ffmpeg as the SRT listener and writes 16 kHz mono PCM. The first PCM arrives within
   about a second (`SRT_ANALYZE_MS`).
2. `pipeline.ts` sends 100 ms frames to Transcribe streaming with language identification between `en-US` and
   `ja-JP`.
3. `language-gate.ts` forwards only results identified as the source language. Japanese speech (a moderator, a
   question from the room) is dropped.
4. `segmenter.ts` turns partial results into chunks of a few words (see "Design choices").
5. `translate-engine.ts` translates each chunk. With the LLM engine a failed or slow call falls back to Translate. With `translateEngine=translate` Translate is the only engine.
6. `chunk-player.ts` asks Polly for speech, picks a speed level, and writes the audio to LiveKit in order. When the
   audio of a chunk starts, it sends the Japanese caption (`caption-publisher.ts`, see "Captions").
7. If the listener falls too far behind, chunks are dropped (`MAX_BACKLOG_MS`) instead of piling up.

## Latency budget

Measured for the start of a sentence with the `talk` profile (fast timing, LLM engine). `e2eFirstWordMs` is
the time from the speaker saying the first word of a chunk to the listener hearing its first translated word.

| Stage | Typical time | Note |
|---|---|---|
| Speaker says the chunk | about 3.2 s | The chunk must be spoken before it can be cut. Shorter chunks lower this. |
| Transcribe waits for stable words | about 2.0 s | Partial-result stabilization (`PARTIAL_STABILITY=high`). |
| Translation (LLM) | about 0.5 s | Amazon Translate is about 0.6 s per chunk faster in this setup but scored lower. |
| Polly | about 0.16 s | One request per chunk. |
| Queue and network | about 0.2 s | Waiting for the previous chunk to finish playing, then WebRTC. |
| **Total, first word** | **about 6 s** | Typical `e2eFirstWordMs` with the `talk` profile. |

The numbers come from the project's own test runs. They depend on the speaker's pace and the venue network.
`./e2e/e2e.sh` measures them for your material, see [e2e-testing.md](e2e-testing.md).

## Design choices

The reasons behind the main choices (managed services, the load balancer, Bedrock and Translate, LiveKit, synchronous calls and streams, where TLS ends) are in [decisions.md](decisions.md). The notes below are the smaller ones.

**LiveKit, not Amazon IVS.** IVS Real-Time accepts WHIP publishing, but it requires an H.264 video track, even
for audio only. LiveKit publishes audio-only from a server SDK and plays it in the browser. It is open source
(Apache-2.0) and runs on one EC2 instance. The Chime SDK has no clean path to publish audio from a headless server.

**OBS and SRT for ingest.** Event teams already know OBS. SRT survives packet loss on venue networks and
supports a passphrase. The Network Load Balancer gives static IPs, so the venue can allow-list them.

**Browser microphone input (optional, `inputSource=browser`).** A second input next to SRT, for venues without an audio line out: a desktop browser page (`/publish`) captures the microphone and publishes it to a separate LiveKit ingest room; the app subscribes and feeds the same `PcmQueue` and pipeline as SRT. One input is active at a time (`INPUT_SOURCE=srt|browser|rtmps`). The security model is in [security.md](security.md#browser-microphone-input) (issue #10).

**RTMPS input (optional, `inputSource=rtmps`).** For venues that block outbound UDP: OBS sends RTMPS to TCP 443 of the LiveKit host, where Caddy's layer4 route (selected by the TLS server name, venue IPs only) decrypts it and forwards plain RTMP through a TCP listener on the existing NLB to the app, which decodes it into the same `PcmQueue` (issue #11). It adds no buffering: in a local loopback test the path through Caddy was about 5 ms slower than direct RTMP. The diagram above shows only SRT.

**Alternative inputs.** The browser and RTMPS paths, with diagrams and the reasons for each design decision, are in [alternative-inputs.md](alternative-inputs.md).

**Language filter.** Rooms with a moderator or questions in Japanese would otherwise be transcribed as English-looking
words and translated into nonsense. Transcribe identifies the language of every result and the app drops results that
are not the source language. Short low-confidence English fragments inside Japanese speech are dropped too.
`LANGUAGE_FILTER=off` restores the old behavior.

**Two channels (built, live tests pending).** With `channels` set, the Japanese speech feeds a second, Japanese-to-English channel with its own segmenter, translation, English voice and LiveKit track, from the same single Transcribe stream: [bilingual-channels.md](bilingual-channels.md) (issue #9).

**Chunking with merge and dangling rules.** The segmenter cuts at sentence ends, at clauses once a chunk has
enough words, and on pauses. Two rules keep chunks translatable:

- *Merge:* a very short sentence ("OK.", "I see.") is held and joined with the next one. Complete sentences are never held.
- *Dangling:* a chunk that would end on a preposition, article or "that" waits a short time for the next words.

Both rules have a time limit, so they cannot stall the speech.

**Speed levels.** Japanese speech is usually slower than English. When the backlog grows, Polly speaks faster, in
graded levels (100, 110, 120, 130, 145 percent by default) with a hold time and hysteresis. Small steady changes
sound calmer than large jumps. In listening tests the delay felt smaller than the numbers suggest, because the speech rate stayed steady.

**Readings with SSML `<sub>`.** Polly mispronounces many product names. The app wraps known terms in
`<sub alias="reading">Term</sub>`. The text shown in logs and any display stays the original term. Only the sound
changes. See [dictionaries.md](dictionaries.md).

## Captions

The listener page shows captions below the **Listen** button after the listener presses it. Before that the page is
the page without captions: it does not connect to LiveKit. There is no toggle and no other control. Two lines roll:

- **Japanese** (primary, larger): the Japanese translation of the English speech, shown when the chunk's Japanese
  audio starts, and Japanese speech (for example audience questions) shown **as said**: untranslated, on its own
  line that starts with `― ` (full-width dash U+2015 and a space) in a subtle blue, one whole sentence at a time (a
  question is never cut in two by a translation line). Both are interleaved in the order they are shown. As-said text is never translated and never spoken: the audio is unchanged.
- **English source** (secondary, smaller, `#555` on white, contrast 7.5:1): shown as soon as the words are recognised,
  several seconds before the Japanese. `?source=off` in the page URL hides it. It is a URL option, not a setting.

The deploy setting `captions` (`on` by default, env `CAPTIONS`, see [configuration.md](configuration.md)) turns both
lines off. With `off` the app sends no data packets and `config.json` has `"captions": false`, so the page behaves as
before captions existed. `captionsJapaneseSpeech` (`on` by default, env `CAPTIONS_JA_SPEECH`) controls only the
as-said Japanese; `off` gives exactly the captions without it.

### Transport

The app's publisher participant (`publisher-app`) sends JSON (UTF-8) as **reliable LiveKit data packets** on topic
`captions` (`@livekit/rtc-node` `publishData`). Browsers receive them with `RoomEvent.DataReceived` in the room they
already joined for the audio. The page ignores other topics and any packet whose sender is not `publisher-app`.
Listener tokens stay subscribe-only (`canPublishData=false`); receiving data needs only `canSubscribe`.

### Event contract (schema v1)

One versioned contract with three event types. The builders are in `app/src/caption-event.ts`, the parser is in
`app/web/captions.js`.

```json
{"v":1,"type":"caption","id":"1-42","seq":57,"session":1,"channel":"ja","lang":"ja","text":"…","sourceLang":"en","sourceText":"…","speaker":null,"final":true,"startAt":1760000000000,"durationMs":3200}
{"v":1,"type":"source","op":"append","id":"1-17","seq":58,"session":1,"resultId":"1a2b3c4d","channel":"en","lang":"en","text":"so today we are","stable":true,"boundary":false,"speaker":null,"audioEnd":12.34}
{"v":1,"type":"source","op":"retract","seq":59,"session":1,"resultId":"1a2b3c4d","channel":"en","lang":"en"}
{"v":1,"type":"speech","op":"append","id":"1-s4","seq":60,"session":1,"resultId":"9f4bdbdd","channel":"ja","lang":"ja","asSaid":true,"text":"すみません。質問です。","stable":true,"final":true,"boundary":true,"speaker":null,"audioEnd":8.25}
{"v":1,"type":"speech","op":"retract","seq":61,"session":1,"resultId":"9f4bdbdd","channel":"ja","lang":"ja","asSaid":true}
```

| Field | Meaning |
|---|---|
| `v` | Major schema version. Consumers ignore events with a `v` they do not know. |
| `type` | `caption` (Japanese chunk), `source` (English words) or `speech` (Japanese speech as said). Unknown types are ignored. |
| `seq` | Increases across both types within one app run. |
| `id`, `session` | `caption`: `<session>-<chunk number>` (as `[chunk N]` in the logs). `source`: `<session>-<batch number>`. |
| `channel`, `lang` | `ja` / `en` today. Used by the two-channel bilingual mode (a `ch` field and a topic per channel, channel 1 unchanged), see [bilingual-channels.md](bilingual-channels.md#captions-per-channel). |
| `speaker` | `null` today. Reserved for speaker detection. |
| `text` | `caption`: the Japanese exactly as sent to Polly, before the SSML `<sub>` readings are applied, so product names are never replaced by readings. `source`: the words of this batch, fillers removed. At most 600 characters. |
| `sourceText`, `sourceLang` | `caption` only: the English that was translated (fillers removed, corrections applied). The page does not show it (the English line comes from `source` events). |
| `final` | Always `true`. `false` is reserved for later partial updates of the same `id`; the page ignores it today. |
| `startAt`, `durationMs` | `caption` only: server time (ms) when the audio starts, and the audio length. Diagnostic. |
| `op`, `resultId`, `boundary`, `stable`, `audioEnd` | `source` only: `append` or `retract`; the Transcribe result (first 8 characters, as in the logs); `boundary` = the batch ends a sentence; `stable` is always `true`; `audioEnd` = stream seconds of the last word (diagnostic). |

`speech` was added after the first release of the contract and is additive: a page that predates it ignores the
unknown `type`. The new page ignores a `speech` event unless `asSaid` is `true` and `channel` is `ja`. `speech`
fields: `asSaid` (always `true`; the browser adds the display-only `― ` marker, it is not part of `text`), `final`
(the batch ends the result), `boundary` (the batch ends a sentence), `speaker` (`null` until #8), `stable` (always
`true`), `op: "retract"` as for `source`. Each `speech` append is one complete sentence (it ends with 。？！ and has
`boundary: true`), except the rest of a sentence that had no end within the hold time or at the end of the stream
(`boundary: false`); the page shows each sentence on its own line.

Changes are additive only: new fields, new `type` or `channel` values. Consumers must ignore unknown fields. A change
that breaks this needs `v: 2`.

### Caption timing

**Japanese.** In `chunk-player.ts` the app knows when a chunk becomes audible: the time of the push plus the audio
still queued in the LiveKit `AudioSource` (up to about 1 s). It arms a timer for that moment just before `pushPcm`,
so the caption packet leaves when the first sample of the chunk leaves the app. If the push fails, the timer is
cleared. Chunks that are dropped, skipped or failed get no caption. All listeners get the same packet, so no clock
sync is needed in the browser.

The audio still passes the browser's jitter buffer and decoder, so the page holds each Japanese caption back by
`CAPTION_OFFSET_MS` (230 ms, in `app/web/subscriber.js`). The value comes from a local measurement (local LiveKit
1.13.7, headless Chrome, the `talk-single` sample, audio onsets found with Web Audio): with 0 ms the captions came
165-271 ms before the voice (median 227); with 230 ms they are within -50 to +55 ms of it (median -9, 19 chunks with
a clear onset). Over a real network both the audio and the data take the same path to the LiveKit host, so the
difference stays mostly the jitter buffer. Measure again with `./e2e/e2e.sh` and a phone if the venue network is very
different.

**English.** The English line comes from `Segmenter.commit()` (`segmenter.ts`), the one place where each word of a
Transcribe result is moved into the chunk buffer, exactly once. Words reach it only after the language gate forwards
them (tagged as English, past the settle rule, stable), so the line shows the same words that are translated: no
unstable partials, no duplicates, nothing the segmenter does not commit. A segmenter tap (`SegmenterTap`) receives each
batch. Errors in the tap are caught, so a caption bug cannot change the chunks. The publisher combines batches of one
result for up to 250 ms (a sentence end flushes at once), so the English stream is at most about 4 packets per second.
Measured on the same run: a batch leaves the app a median 1.4 s (p90 1.8 s) after its last word was spoken, while the
Japanese voice of that text starts a median 7.3 s after the last English word with the Amazon Translate engine (the low-cost mode)
(the sample is dense, so the queue grows).

**Retraction.** Transcribe can tag a result as Japanese only in its final, after the gate already forwarded it (late
flip, `late=` in the `[langfilter]` line). The app then sends `op: "retract"` for that `resultId` and the page removes
those words from the English line. Such words can be visible for a few seconds before they disappear. In the local
run there were no late flips (`late=0`, `retracted=0`).

**Fillers.** Single-word fillers (`um`, `uh`, the `fillers` words) are not shown, as they are not translated.
Multi-word filler phrases (`you know`, `I mean`) are removed only from whole chunks before translation, so they can
still appear in the early English line.

**Japanese speech as said.** The language gate (`language-gate.ts`) sees every Transcribe result with its language
tag. Results tagged Japanese used to be dropped. Now a `JapaneseSpeechTap` also receives the stable words of a
Japanese result that was never forwarded as English: after 3 stable words (language flips happen near the start of a
result), then each newly stable word, and the rest at the final. The words go only to the tap, never to the segmenter,
so Translate, the LLM and Polly never see them. A result tagged Japanese whose words contain no Japanese character
(English heard as Japanese for a moment) is not shown. Japanese fillers (`JA_FILLER_PATTERNS`: ええと, あの, …) are
hidden only where it is safe: before 、 or 。, at the end of a result, and `つまり、` only at a sentence start; a
possible filler at the end of the stable words waits for the next word, so `あの人` keeps its demonstrative. The
publisher holds these words and sends one `speech` event per sentence: at 。？！, or the rest of an unfinished
sentence 1 s after its result ended without a continuation (Transcribe often ends a result in the middle of a
sentence; the next result then continues it, and both parts go out as one sentence), at the end of the stream, or 5 s
after the first held word (`JA_HOLD_MAX_MS`, `JA_CARRY_MS` in `caption-publisher.ts`). A sentence therefore appears
whole, which cannot happen while a translation line is shown in the middle of it. Held words of a result that
flips to English are discarded. If a result flips to English after its Japanese was published, the app sends `speech` `retract` and the page removes
those words (no duplicate with the translation that follows). A result already forwarded as English is never shown as
Japanese. Measured on `qa-bilingual` (local): a sentence left the app a median 2.7 s (p90 3.0 s, n=6) after its last
word was spoken, and a median 5.9 s after its first word (the sentence itself lasts that long). In a real Q&A slice
with long, unpunctuated Japanese the median from the last word was 2.9 s (p90 5.0 s, n=17): sentences without a 。
wait for the 1 s carry or the 5 s hold, so a long question can be shown as two lines.
**Order.** As-said text has no audio to wait for and appears about 2-3 s after the last word of its sentence, while the
Japanese translation of English speech appears with its voice, several seconds after the English was spoken. A
question that follows an English answer would therefore land between two translated lines of that answer. The page
prevents this: an as-said line waits for the open translated sentence to end, up to 3 s (see Page behaviour), so the
answer is shown whole and the question after it. Measured on `qa-bilingual` (local, replayed through the page): 1 of 6
as-said lines waited, for 0.2 s in one run and 1.1 s in another; the others were shown at once. A change of kind
always starts a new line, so the two are never mixed in one line. Speaker labels with #8
will make this easier to read.
### Page behaviour

`app/web/captions.js` is a small pure module (no DOM access, unit-tested in `app/test/captions-assembler.test.ts`):

- Japanese: chunks of one sentence merge into one line until `。？！`, 60 characters, or 6 s without a new chunk.
  A line fades out 12 s after its last update. Each as-said sentence (`speech` event) starts a new line with its marker; a change
  between translated and as-said text always starts a new line, and a retract removes the words of that result.
  Only the rest of a sentence released early (no end within the hold time) joins the as-said line it continues, when
  no other line came after it.
  An as-said line that arrives while the newest translated line is still open (it does not end with `。？！` or a
  closing bracket after them) waits in a queue (`SAID_QUEUE_MS` = 3 s). Queued lines are shown in order right after
  the translated line that ends a sentence, after 3 s in the queue, or when no new translated text came for 3 s. A
  retract removes a queued line. Translated lines are never held or reordered; with no open translated line an
  as-said line is shown at once.
  As-said lines start with `― ` and use `#1a4a8a` (8.8:1 on white; `#4a6585`, 6.0:1, when older). The marker carries
  the meaning, the colour is a second cue. A line that wraps at the maximum length continues the same utterance
  and does not repeat the `― `.
- English: lines group by sentence across Transcribe results (a result often ends mid-sentence). Batches join
  into one line that ends at `.?!`; a pause does not end it. The page wraps long lines itself, so the only length
  limit is a safety limit of 240 characters (`EN_MAX_LINE_CHARS`) for a speaker who never ends a sentence: the line
  is cut after the last comma, semicolon or colon within the limit, else at the last space. `boundary` is not used
  to end a line, because it only says a sentence ended somewhere in the batch. At most 3 lines, 10 s before fading.
  A retract removes exactly that result's words, also inside a joined line (a line break already made stays).
- Text goes into the page with `textContent` only. A test fails if the page code contains `innerHTML` or similar.
- Late joiners (and reconnects) see captions from the next words on. There is no history.

Layout: when **Listen** is pressed the page becomes exactly one small viewport tall and does not scroll, and nothing
moves afterwards. The heading, button, status line and hint are never hidden or moved. The page script measures once
(`applyLayout` in `subscriber.js`, pure arithmetic in `computeLayout` in `captions.js`) and fixes both areas in px:
- The **English** area is pinned near the bottom: 3 lines, 12 px above the bottom edge and above
  `env(safe-area-inset-bottom)` (fewer lines when the screen is too short).
- The **Japanese** area sits above it with a clear gap (at least 12 px), bottom-anchored, and takes the space down
  from the hint in whole lines (at most 8). Older lines are cut off at the top with a soft fade.
- Sizes come from the **small** viewport height (`100svh`, probed once; `100vh` only where `svh` is unknown, then the
  smaller of it and the current height). The dynamic viewport unit is never used, so the Safari toolbar showing or
  hiding changes neither the sizes nor the positions. The layout is measured again only when the width or the small
  viewport height changes (rotation, window resize), never on scroll.
- `?source=off`: no English area; the Japanese area keeps the same position and size. With `captions` off the page is
  unchanged.
Lines (Japanese / English), measured in headless Chrome: 390x844 8 / 3, 390x664 8 / 3, 844x390 2 / 1,
1366x768 7 / 3, 1920x1080 8 / 3. The font sizes scale with `clamp()`, so the same page works on a phone and on a
projected screen.
The fade is turned off for `prefers-reduced-motion`. The Japanese area is `aria-live="polite"` for screen readers. The
English area is not announced, as it changes several times a second.

## Edit the diagram
`docs/architecture.drawio.svg` and `docs/overview.drawio.svg` (the landing diagram in the README) are the only sources of their diagrams. Export either with `scripts/export-diagram.sh FILE`. There is no generator. When a change touches the
architecture (a new service, a new data path), update the diagram and the step table above in the same pull request.

**By hand.** Open the file in draw.io Desktop (`brew install --cask drawio`) or at https://app.diagrams.net
(File > Open from > Device). Edit it, then File > Save. The file stays a `.drawio.svg`. Before you commit, run:

```bash
scripts/export-diagram.sh            # re-exports the file with the draw.io CLI, uncompressed, and scrubs it
# or, at least:
scripts/scrub-drawio.sh docs/architecture.drawio.svg
```

draw.io writes the host name, a user-agent string and a timestamp into the file. `scrub-drawio.sh` sets the host to
`app.diagrams.net` and removes `agent`, `etag` and `modified`. `scripts/check-publishable.mjs` fails if that metadata
is still there. A diagram saved by draw.io with compression on is a blob that git cannot diff; `export-diagram.sh`
writes it back as readable XML (draw.io: File > Properties > Compressed is off).

**By an agent or a script.** The diagram is the mxGraph XML inside the `content="..."` attribute of the SVG
(HTML-escaped). Edit the XML (add a `resourceIcon` cell with `resIcon=mxgraph.aws4.<service>`, add an edge, move a
group), then run `scripts/export-diagram.sh`. The draw.io CLI redraws the picture from the XML. Export a PNG to look at
the result, for example
`draw.io --export --format png --scale 2 --output /tmp/preview.png docs/architecture.drawio.svg`, and check that
no icon renders as an empty box (a wrong `resIcon` name does that).

**CI.** `node scripts/check-diagram.mjs` runs in CI without draw.io. It checks that the file exists, is well-formed XML,
embeds an uncompressed `<mxfile>`, has no machine metadata, and that every `resIcon`, `grIcon` and `shape` is an
`mxgraph.aws4` name. It does not check the layout; look at the picture.

**Icons and trademarks.** AWS publishes the [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) so
that customers and partners can create architecture diagrams. Read the terms on that page before you reuse the icons
elsewhere. Do not change the icons' shape or colours, and do not use them to suggest that AWS endorses this project.
AWS service names and icons are trademarks of Amazon.com, Inc. or its affiliates. This is an unofficial open-source
project (see the footer of the diagram and the README).
