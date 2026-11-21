# Two-channel bilingual mode (design)

**Status: planned, not built.** This page is the design for [issue #9](https://github.com/kuu/realtime-speech-interpreter/issues/9).
No code, setting, file name or log line described here exists yet. Everything in "Hypotheses" and every number marked
*estimate* has to be measured before it is relied on. Questions that need an answer from the project owner are in
[Open questions](#open-questions).

## Goal

A human simultaneous interpreter listens to one mixed venue feed and speaks into two microphones: Japanese for the
Japanese listeners when the room speaks English, English for the English listeners when the room speaks Japanese. The
product does the same, with the constraints below.

| | Channel 1 (listeners: Japanese) | Channel 2 (listeners: English) |
|---|---|---|
| Source speech | English (`en-US`) | Japanese (`ja-JP`) |
| Output | Japanese voice and captions | English voice and captions |
| Other-language speech | Dropped from the audio. Shown as said (`― `), as today. | Dropped from the audio. Shown as said (`― `). |

Fixed constraints (decided, not reopened here):

- One input feed (SRT, browser microphone or RTMPS, one per deploy). No per-microphone inputs.
- One Amazon Transcribe streaming session. No second stream.
- The listener page keeps only the **Listen** button. No toggle, no mode control, captions only after Listen, fixed
  caption positions, never scrolling, the Japanese area up to 8 lines, the English area pinned near the bottom,
  `?source=off` hides the source area.
- Low latency is the first priority. With one channel configured the product behaves exactly as today.
- Product names are never changed in any text. Katakana appears only in metadata such as SSML aliases.

## Contents

1. [Design in one picture](#design-in-one-picture)
2. [Configuration](#configuration)
3. [Routing one Transcribe stream to two channels](#routing-one-transcribe-stream-to-two-channels)
4. [Japanese segmenter](#japanese-segmenter)
5. [Translation Japanese to English](#translation-japanese-to-english)
6. [English voice](#english-voice)
7. [Dictionaries per direction](#dictionaries-per-direction)
8. [LiveKit](#livekit)
9. [Captions per channel](#captions-per-channel)
10. [Listener page and URL scheme](#listener-page-and-url-scheme)
11. [Operator, doctor and e2e changes](#operator-doctor-and-e2e-changes)
12. [Cost](#cost)
13. [Latency: hypothesis and measurement plan](#latency-hypothesis-and-measurement-plan)
14. [Failure isolation](#failure-isolation)
15. [Single-channel parity](#single-channel-parity)
16. [Acceptance criteria and tests](#acceptance-criteria-and-tests)
17. [Open questions](#open-questions)
18. [Not in scope](#not-in-scope)

## Design in one picture

```
venue audio (one input) -> PcmQueue -> one Transcribe stream (en-US + ja-JP, vocabularies for both)
                                              |  every partial and final carries a LanguageCode
                                              v
                                    result fan-out (same results to every lane)
                       +----------------------+-----------------------+
                       v                                              v
        lane "ja" (source en-US, target ja)             lane "en" (source ja-JP, target en)
        LanguageGate(en) -> Segmenter (English)         LanguageGate(ja) -> JapaneseSegmenter
        -> engine en->ja (Translate or LLM)             -> engine ja->en (Translate or LLM)
        -> ChunkPlayer -> Polly ja voice                -> ChunkPlayer -> Polly en voice
        -> LiveKit participant "publisher-app"         -> LiveKit participant "publisher-app-en"
           track "translation-audio"                       track "translation-audio-en"
           data topic "captions"                           data topic "captions-en"
```

A *lane* is everything after the Transcribe stream for one channel. Lanes share nothing except the stream and its
start time `t0`. Each lane has its own gate, segmenter, translation engine (and its own LLM circuit breaker), chunk
player, speed controller, backlog limit, LiveKit connection and caption publisher. The lane for channel 1 is the
code that exists today, unchanged.

## Configuration

### Shape

`cdk/config/event.json` gets one new optional key, `channels`, a list of one or two lanes:

```json
{
  "channels": [
    { "source": "en-US", "target": "ja", "pollyVoice": "Kazuha" },
    { "source": "ja-JP", "target": "en", "pollyVoice": "<en-US neural voice, see English voice>",
      "transcribeVocabulary": "simul-translation-ja", "translateTerminology": "simul-translation-ja-en" }
  ]
}
```

| Channel key | Type | Default | Meaning |
|---|---|---|---|
| `source` | Transcribe code | required | Language of the speech this lane translates. Must be in `languageOptions`. |
| `target` | Translate code | required | Language of the lane's listeners. Also the **channel id** (`ja`, `en`) used in URLs, track names and events. |
| `pollyVoice` | string | from the flat key for the first lane; required for others | Polly voice that speaks `target`. |
| `translateEngine` | `translate` or `llm` | the global `translateEngine` | Lets channel 2 run on Amazon Translate while channel 1 uses the LLM, or the reverse. |
| `transcribeVocabulary` | string | the global value for the first lane; `""` for others | Transcribe custom vocabulary for `source`. |
| `translateTerminology` | string | the global value for the first lane; `""` for others | Translate terminology for `source` to `target`. With the LLM engine it must be set (the LLM reads its glossary from it), as today. |

Channel keys are the only per-lane settings in the first version. Chunking, speed, LLM timeouts and caption settings
stay global, and each lane reads the global key that fits its language (the English segmenter keys for an English
source, the new Japanese segmenter keys for a Japanese source, see [Japanese segmenter](#japanese-segmenter)). A
per-lane override can be added later without a breaking change.

### Default and compatibility

- `channels` absent = one lane built from the flat keys that exist today (`sourceLanguage`, `targetLanguage`,
  `pollyVoice`, `translateEngine`, ...). This is the default and nothing else changes.
- `channels` with exactly one entry equal to what the flat keys give (`en-US` to `ja`) is normalised to the same thing
  as absent: no new environment variable, same task definition (tested, see [Single-channel parity](#single-channel-parity)).
- `channels` together with the flat keys `sourceLanguage`, `targetLanguage` or `pollyVoice` in `event.json` (or the
  same `-c` keys) is rejected with a message naming both. Two ways to say the same thing would need a precedence rule
  that nobody remembers on event day. The other flat keys (`translateEngine`, `dictionaries.*`) stay valid and act as
  defaults for the lanes.
- A single entry that is not the default, for example `ja-JP` to `en` (a venue where the speakers talk Japanese and
  all listeners read English), is valid and runs one lane.

### Validation (CDK synth and app start, same rules in both)

| Rule | Reason |
|---|---|
| 1 to 2 channels. | More lanes belong to [#19](https://github.com/kuu/realtime-speech-interpreter/issues/19). |
| `source` codes are distinct. | A result has one language, so routing by language is only unambiguous with one lane per source. |
| `target` ids are distinct and match `^[a-z]{2,3}$`. | They appear in URLs, participant identities and topics. |
| `target` is not the language prefix of the lane's own `source`. | A lane that translates English into English is a typo. |
| Every `source` is in `languageOptions` (default `en-US,ja-JP`). | The router can only see languages Transcribe identifies. |
| The first lane's `source` is the Transcribe `PreferredLanguage`. | Same meaning as `sourceLanguage` today. |
| `pollyVoice` is a Polly voice; `doctor` also checks that it exists in the Region and engine (see [Operator](#operator-doctor-and-e2e-changes)). | Fails on the laptop, not on event day. |
| With the LLM engine on any lane, that lane has a terminology name. | The glossary comes from it. |
| Unknown keys inside a channel are rejected. | Same rule as the rest of `event.json`. |

CDK passes the normalised list to the container as one JSON environment variable, `CHANNELS` (set only when the list is
not the default). The app parses and validates it again at start and refuses to run on an invalid list, as it does for
`RTMP_STREAM_KEY` today. Both sides share one validation function so the rules cannot drift.

The first lane is the **default channel**: the listener URL without a parameter plays it, and it keeps the legacy
LiveKit names (below). Put the language of the majority of listeners first.

## Routing one Transcribe stream to two channels

### What Transcribe gives us

With multi-language identification every partial and final result has a `LanguageCode`. The measurements below come
from 34.5 min of recorded Q&A (162 final Japanese results, 1,388 consecutive Japanese partial pairs), taken from earlier
probe runs, in multi-language mode with partial stabilization `high`. No new audio was streamed for this design.
Details are in [Measured Japanese results](#measured-japanese-results).

- The language code of a **partial** is not reliable: in 10.9% of results (45 of 414) it changed between partials, and
  11.5% of the results that started as Japanese were finalised as `en-US` (21 of 183).
- The code of a **final** is the one to trust.
- Speaker labels are on hold ([#8](https://github.com/kuu/realtime-speech-interpreter/issues/8)): a probe saw them
  only on finals, 5 to 17 s late. They do not help routing. A language switch shows in the partial code about 3.8 s
  after it starts.

### One gate per lane, same input

The existing `LanguageGate` already does the hard part for one source language: it settles a result before it forwards
it, tracks committed audio so a split result is not spoken twice, retracts words when a result turns out to be another
language, and applies the short low-confidence rule. The router gives **every lane the same stream of results** and each
lane owns a gate configured with its own `source`. Lanes do not talk to each other, so there is no shared state to get
wrong, and the single-lane case is today's code path with one gate.

What changes in the gate (all behind the lane's `source`/`target`; with the default lane every branch takes today's
path):

| Part | Today (hardwired) | Generalised |
|---|---|---|
| Source test | `lang === opts.source` | same |
| As-said tap | results tagged Japanese, check for a Japanese character | results in the lane's **target** language (`ja` or `en`), with a script check per language (Japanese character for `ja`, Latin letter for `en`) |
| Settle rule | `langidSettleWords` or dynamic (3, or 5 within 60 s after Japanese) | same, in "stable items" for Japanese: 3, or 5 within 60 s after the other language (`JA_SETTLE_ITEMS` is already 3 for the as-said path) |
| Short low-confidence rule | English result of at most 4 words with mean confidence below 0.6 right after a non-source final: dropped | Japanese result of at most `jaShortChars` characters (default 4) with the same confidence rule, right after a non-source final: dropped. Same intent: fragments of the other language inside a passage. |
| Late flip | words already forwarded to the segmenter are removed (`closeResult`) | same |

### Partials, finals and a language switch mid-result

Rules for lane L with source `s` (written for channel 2, `s = ja-JP`; channel 1 is the same with the languages swapped):

| Event | Lane `ja-JP` does | Lane `en-US` does (as today) |
|---|---|---|
| Partial tagged `ja-JP` | After the settle rule, forwards the stable items to its segmenter. | Treats it as as-said Japanese (existing path). |
| Partial tagged `en-US` | Never forwards. If the result had been forwarded, waits for the final (no early retract: the code flips back in 1.2% of partial pairs). | Settle rule, then forward. |
| Final tagged `ja-JP` after the partials were tagged `ja-JP` | Commit the rest and verify, as the English lane does. | Drop (`non-source`). |
| Final tagged `en-US` after partials that were `ja-JP` | The words that are not yet in a chunk are removed (`non-source-late`). A chunk already cut and spoken cannot be recalled: this is counted (`lateSpoken`) and is an acceptance metric. | Forward (the result was held while settling; the first words wait for the settle rule). |
| Final of a result never forwarded | Dropped, or shown as said if it is in the lane's target language. | same |

The time a language switch costs is the same for both lanes: the first result after a switch is tagged with the old
language for a while (about 3.8 s in the probe), so the lane of the new language starts that long after the switch
begins. This is the dominant source of channel-2 delay when the room alternates, and the reason the English lane
already has the dynamic settle threshold. For Japanese the same mechanism applies; whether 3 and 5 stable items are
the right values is a measurement (`lateSpoken` against the first-chunk delay after a switch).

### Short interjections

Without speaker labels the language of the *result* is all we know. Examples, with what happens:

| Situation | Result language | Channel 1 | Channel 2 |
|---|---|---|---|
| A Japanese moderator says "Thank you" in English | `en-US`, short | Translated and spoken as today (the English lane cannot know who spoke). | Shown as said (English, `― `). Not spoken. |
| An English speaker says one Japanese word ("はい") | `ja-JP`, 1 to 3 characters | Shown as said, as today. | Held back by the settle rule (3 stable items) and then dropped by the short rule if its confidence is low. A real short Japanese reply that passes the rules is translated ("Yes"). |
| Japanese fragments or English fragments inside a passage of the other language | mixed codes | The existing short low-confidence rule. | The mirrored rule above. |

This is the accepted behaviour until #8 can label speakers reliably. It is the same trade-off the English lane
already makes, and it costs the listener a spoken "Thank you" or a dropped "はい" at worst.

### Overlap and ordering

A result has one language, so a result reaches at most one lane as source. Two lanes can both be speaking when the room
alternates quickly: they are different tracks, and a listener hears only one. Each lane's backlog and speed control
work on their own queue. There is no cross-lane ordering to keep.

## Japanese segmenter

A new module, `app/src/segmenter-ja.ts`, with the same public surface as `Segmenter` (`onResult`, `noteActivity`,
`tick`, `closeResult`, `endOfStream`, and the caption tap). The English `Segmenter` is not edited. The gate holds the
segmenter through a small interface (`ResultSink` plus `closeResult`) so both fit.

### Facts the rules rest on

- Japanese has no spaces. The unit is the **character** (kanji, kana, Latin letters and digits counted individually;
  punctuation not counted), not the word.
- Transcribe returns items that are short tokens plus punctuation items `。` `、` `？` `！`. The measured results:
  125 of 162 final Japanese results (77%) contain punctuation, 96 of 162 show a stable punctuation mark in a partial
  before the final.
- A clause that ends in `。？！` is a median 10 characters (p90 19, p99 35, max 51). A clause that ends in `、` is a
  median 8 characters (p90 26, p99 52).
- Items flagged `stable` that later changed: **0 of 1,332** pairs. A stable prefix is safe to cut on. Other
  partials change their prefix in 15.1% of pairs, so nothing unstable is committed.
- Japanese is verb-final. The meaning of a clause is complete only at its last token, so an early cut costs quality
  more than in English.

### Cut rules

The segmenter keeps a buffer of committed (stable) characters, like the English one. It cuts when the first rule below
that applies is met, in this order.

| # | Rule | Cut when | Default |
|---|---|---|---|
| 1 | Sentence end | A stable `。` `？` `！` (also ASCII `?` `!`) is committed and the sentence has at least `jaSentenceMinChars` characters. Shorter sentences go to merge-short. | min 6 |
| 2 | Clause end | A stable `、` is committed, the buffer has at least `jaClauseMinChars`, and the clause does not end in a dangling token (below). | min 12 |
| 3 | Clause-ending form without punctuation | The buffer has at least `jaClauseMinChars` and its last stable token is a clause-closing form followed by a pause of `jaPauseMs` (for example a conjunctive particle such as `ので`, `が`, `けど`, `ため`, or a て-form). Used because 23% of Japanese results have no punctuation. | on |
| 4 | Maximum characters | The buffer reaches `jaMaxChars`. Cut at the last stable `、`, else at the last clause-closing form, else at the last token that is not dangling, within `jaDanglingMaxChars` extra characters. | 40, extra 10 |
| 5 | Pause | No new transcript activity for `jaPauseMs` (as `chunkPauseMs` today). | 900 ms |
| 6 | Maximum wait | The oldest uncut stable character is older than `jaMaxWaitMs`. Cut as in rule 4. | 4000 ms |
| 7 | Final | Transcribe finalises the result. Commit the rest. | n/a |

**Merge-short.** A sentence shorter than `jaSentenceMinChars` (for example `はい。`, `ありがとうございます。`) is held
and joined with the next sentence, with the same `mergePauseMs`/`mergeMaxHoldMs` limits as English, so short replies are
not spoken as separate one-word chunks and are never held forever.

**Dangling tokens (do not cut here, wait up to `jaDanglingMaxHoldMs`, default 500 ms).** A buffer must not end on a
case or topic particle (`は` `が` `を` `に` `で` `と` `の` `も` `へ` `や` `から` `より` `まで`), on a stem that needs its
ending (a token marked as an incomplete verb or adjective stem), on a sentence-initial connective with nothing after it
(`そして` `しかし`), or on a number with no counter. The list is a built-in default, replaceable by `jaDanglingTokens`.
Whether the segmenter uses a tokenizer or only the Transcribe items and a particle list is decided in the
evaluation below; the first version uses the Transcribe items and the list, with no extra dependency.

**Fillers.** Japanese fillers are removed **before** translation, from the source text, with the existing
`jaFillerPatterns` list and the same safety rules as the as-said path (only before `、` or `。`, at the start or the end
of a result). Today that list runs after Translate; the source-side use is new.

**Latency order of the rules.** Rules 1, 2 and 7 use only stable punctuation and give the shortest delay. Rules 4 to 6
exist so that one long unpunctuated stretch cannot hold the lane: with the measured tail (results of 12.9 s at p90 and
25 s at p99) waiting for the final would delay such chunks by up to about 25 s.

### New settings (all new keys documented in `configuration.md` when built)

`jaSegmentationMode` (`clause` default, `sentence` revert), `jaSentenceMinChars`, `jaClauseMinChars`, `jaMaxChars`,
`jaPauseMs`, `jaMaxWaitMs`, `jaDanglingTokens`, `jaDanglingMaxChars`, `jaDanglingMaxHoldMs`, `jaShortChars`,
`jaShortMinConf`. Defaults above are starting values for the evaluation, not results.

### How the segmenter is evaluated

1. **Replay harness, offline, no AWS.** Feed recorded Transcribe result streams (JSON with items, times, stability,
   language) through gate and segmenter with a fake clock. Recordings and transcripts stay out of the repository:
   committed fixtures are synthetic Japanese written for the tests, with hand-set timings. Real recordings stay in the
   private folder and only statistics go into the repo.
2. **Invariants (unit tests).** The concatenation of all chunks equals the committed stable text (nothing lost, nothing
   twice, also across a split result and a retract). No chunk is empty. Every chunk is cut by exactly one logged
   reason.
3. **Distributions per reason**, as the English `report.md` already prints: characters per chunk, time from the first
   character spoken to the cut (`commitLagMs`), share of cuts by rule, share of chunks that end on a dangling token or
   have fewer than 6 characters. Target: no rule except 7 produces more than half the chunks on the evaluation set;
   dangling-end chunks under 5%.
4. **Quality judgement.** The existing `side-by-side.wav` method: a person scores meaning and fluency of the English
   per chunk on a short scale and records it in the report's judgement section, comparing the rules on and off
   (for example rule 3 on/off, `jaClauseMinChars` 8, 12, 16).
5. **Parameter sweep** over `jaClauseMinChars`, `jaMaxChars` and `jaPauseMs` on the replay harness using the measured
   delay of stable punctuation, then confirm the best two values live (a few minutes of real Transcribe per variant).

### Measured Japanese results

From the earlier probe data (reuse only; 2,068 s of non-overlapping Q&A slices; multi-language mode, stability `high`,
speaker labels on; no new audio, no new cost). The speaker mix is mostly short Japanese utterances, so long Japanese
monologue is under-represented. A pure `ja-JP` session on a long monologue was not measured.

| Metric | p10 | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| Final result duration (s) | 0.79 | 2.28 | 12.9 | 25.1 | 25.9 |
| Characters per final result | 3 | 14 | 84 | 147 | 205 |
| Speech start to first stable `。、？！` (audio s) | 0.09 | 0.51 | 3.5 | 6.4 | 9.5 |
| Wall delay of that punctuation after its audio position (s) | 1.7 | 2.9 | 4.6 | 6.3 | 8.8 |
| Wall delay of the final after its end (s) | 0.85 | 2.66 | 5.9 | 7.3 | 8.8 |
| First partial after speech start (s) | 1.4 | 3.4 | 5.8 | 8.0 | 8.6 |
| Clause length ending `。？！` (s / characters) | 0.19 / 2 | 0.97 / 10 | 2.6 / 19 | 4.6 / 35 | 6.9 / 51 |
| Clause length ending `、` (s / characters) | 0.11 / 1 | 1.08 / 8 | 4.2 / 26 | 8.2 / 52 | 10.0 / 54 |
| First stable punctuation to the final (s) | 0.0 | 1.4 | 18.0 | 28.0 | 29.6 |

## Translation Japanese to English

### LLM engine (Claude Haiku 4.5 on Bedrock)

`llm-prompt.ts` holds the English-to-Japanese prompt, copied from a benchmarked prompt and tied to one event's topic.
The reverse direction gets its own template in a new file (`llm-prompt-ja-en.ts`), selected by the lane's
source/target, never by editing the existing one. The existing prompt text and its tests stay as they are.

The prompt for `ja` to `en`:

- Role and I/O format as in the existing prompt (chunk in, translation out, `<previous>` context, stop sequences,
  `chunk_ends_sentence` flag set by the app from the source's `。？！`, so a chunk cut mid-sentence is translated as an
  open fragment and not closed with a period).
- Output is English only: no Japanese, no explanation, no quotation marks added.
- **Product names and technical terms appear in English exactly as written in the glossary** (spelling, case, spacing).
  When the speaker's text contains a Japanese rendering of a product name (katakana), the glossary maps it back to the
  official English name. Names in Latin script in the source are copied unchanged. The model never translates or
  respells a name.
- Japanese is verb-final and often drops the subject: the prompt tells the model to produce the English of the clause
  seen so far, to use the previous chunks to resolve the subject, and not to invent a subject when the context has none.
- Personal names: Western order (given name first), unless the glossary says otherwise (see open question 6).
- Fillers and hesitations (`えーと`, `あの`) are not translated.

The glossary for this lane comes from the **ja-to-en terminology** (next section). The same cached-prompt design is
used; the cache is per lane, so the second lane adds its own `cachePoint` and keep-warm call (see [Cost](#cost)).

A **name check** runs after the model answers, in code, not in the prompt: for every glossary entry whose Japanese side
occurs in the source chunk, the English side must occur in the output (case-insensitive for the check, the output is
used as the model wrote it). If not, the existing validation path falls back to Amazon Translate for that chunk, which
applies the terminology itself. Fallback is counted per lane in the log.

### Amazon Translate engine

`TranslateText` with source `ja`, target `en`, the ja-to-en terminology, no formality setting (`translateFormality` is
a Japanese-target setting and is not sent for an English target). Translate remains the per-chunk fallback of the LLM
engine, as today.

## English voice

- **Engine and voice.** A neural English (`en-US`) Polly voice available in the stack's Region is the starting
  point, because channel 1 already runs on a neural voice and its synthesis time (about 0.16 s per chunk) is part of
  the measured budget. Polly also offers generative voices, but the generative engine's latency and Region availability
  have to be measured before it is chosen, and the first byte time is what matters here. `doctor` checks the chosen
  voice with `aws polly describe-voices --region <region> --engine <engine> --language-code en-US`. The voice name is
  an open question with a recommendation (see question 3); it is a channel key, so it is a deploy-time choice.
- **Speed control.** English speech is usually faster than the Japanese speech it replaces (Japanese to English is
  roughly the reverse of today's problem: fewer syllables per idea). The speed levels (100 to 145%) exist because
  Japanese output is slow. Lane 2 starts with the same `speedMode=levels` code but with the levels and thresholds
  **off (`100` only)** until measurement shows a backlog; `speedMsPerChar` (165 ms for Japanese) does not apply and needs
  a measured English value (milliseconds per character at 100%) before levels can be enabled for lane 2.
- **Readings (SSML `<sub alias>`).** The alias text is the spoken form. For English output, an English voice can say
  most names; the cases that need help are acronyms and Japanese proper nouns. Aliases for them come from the new
  `reading_en` column (next section). The displayed text and the caption text are never changed, and katakana is not
  used for English output.
- **Japanese names.** A Polly English voice reads romanised Japanese names acceptably in the usual case. Anything that
  sounds wrong goes into the dictionary as a `polly_en` row with an English-spelled alias (for example hyphenated
  syllables). No attempt is made to speak Japanese inside the English voice.

## Dictionaries per direction

Today `terms.csv` has one text column per language (`en`, `ja`), a katakana `reading` for the Japanese Polly voice, and
direction-named flags. The builder reserves `transcribe_ja`, `translate_ja_en` and `polly_en`, accepts them, ignores
them and prints a note ([dictionaries.md](dictionaries.md)). The design uses those three flags.

### Columns

| Column | Status | Meaning |
|---|---|---|
| `transcribe_ja` | reserved today | `y`: write a Transcribe vocabulary row for `ja-JP`. |
| `translate_ja_en` | reserved today | `y`: write a Translate terminology row, Japanese source to English target. |
| `polly_en` | reserved today | `y`: write a Polly reading used when the app speaks English. |
| `reading_en` | **new, optional** | The spoken English alias for the English Polly voice. Required when `polly_en=y`. |
| `ja_variants` | **new, optional** | Other Japanese spellings that should map to the same `en`, separated by `|` (for example the katakana rendering and a kanji form). Each becomes its own terminology row. |

For a row with `translate_ja_en=y` the Japanese side is `ja` (the spelling to match) plus `reading` and each of
`ja_variants`; the English side is `en`. Product names keep their English spelling as the target, which is how they
appear unchanged in English output. The rule from the English direction holds here: `en` is never respelled.

### Generated files (only written when at least one row has the flag)

| File | For | Uploaded as |
|---|---|---|
| `transcribe-vocabulary-ja.txt` | lane `ja-JP` source | Transcribe vocabulary `<name>-ja` (language `ja-JP`) |
| `translate-terminology-ja-en.csv` | lane `ja-JP` to `en` | Translate terminology `<name>-ja-en`, uni-directional (`ja`, `en` columns) |
| `polly-readings-en.csv` | English voice readings | Packaged into the app image, like `polly-readings.csv` |

The existing example dictionary has none of the new flags, so `generate` writes the same three files as today, and
`generate --check` on the example is unchanged (tested). Without a flag, no new file appears.

### Transcribe vocabulary for Japanese

Multi-language identification takes **one vocabulary per language** (`VocabularyNames`, comma separated, each matching
a language option); today it is one name. With two lanes the app passes both. A Japanese vocabulary has its own rules
for allowed characters in `Phrase` (the English acronym rule `A.B.C.` does not apply). The validator checks the
`ja-JP` rules from the Transcribe documentation, which have to be read again at build time because they can change;
for the vocabulary row the `reading` (katakana) is the natural `Phrase` and `en` the `DisplayAs`, which also makes the
transcript show product names in Latin script. Whether Transcribe accepts that for `ja-JP` is the first thing to check
by experiment before the builder is written.

### Translate terminology: separate resource

Translate supports multi-directional terminologies, but the deployed English-to-Japanese terminology is uni-directional,
and replacing it would change a resource channel 1 depends on. The design therefore creates a **second terminology**,
`<name>-ja-en`, and leaves `<name>` untouched. Either lane's engine reads its own terminology (for the LLM the glossary,
for Translate the `TerminologyNames` parameter). The deployed names are not renamed.

### Builder, validator, upload

- `build.mjs generate` writes the new files when flags are present, validates them with the same pre-write check as
  today (no file is replaced when validation fails), and `generate --check` compares all files.
- `validate.mjs` gets rules for each new file: Japanese vocabulary phrase characters, terminology column order and
  language names, `polly-readings-en.csv` alias without katakana, uniqueness per file, no comma, quote, TAB or newline
  in a field (as for the others).
- `dictionaries.sh` uploads `transcribe-vocabulary-ja.txt` and `translate-terminology-ja-en.csv` only if the files
  exist, with the same dry-run and `--restart-app` behaviour. It is not run as part of this design.
- `suggest` (and the optional Bedrock helper) gets a direction: in a bilingual deployment it proposes the Japanese
  spelling and the reading for terms heard on the Japanese side.
- IAM: the task role needs `translate:GetTerminology` on the second terminology (the CDK stack already scopes it to
  one name; it becomes a list).

## LiveKit

### One room with two tracks, or two rooms

| | One room, two publisher participants (recommended) | Two rooms |
|---|---|---|
| Token endpoint | **Unchanged.** The token grants subscribe to one fixed room and no request value reaches the grant. | Must take a channel value from the request to pick a room. That breaks "no request input influences the grant" and needs an allow-list in the Lambda. |
| Listener choice | The page subscribes to one track by name. Nothing on the server knows the choice. | The page asks for a token for a room. |
| Tracks the listener receives | One (the page turns automatic subscription off in a bilingual deploy and subscribes to one). | One (it is in its room). |
| Data packets | Both lanes' caption packets reach every listener, and the page ignores the other topic. Estimate: the other channel's captions are a few KB per second at most, see [Cost](#cost). | Each listener receives only its own channel's packets. |
| App | Two LiveKit connections (one per lane), same room. | Two connections, two rooms, two sets of room settings. |
| Failure | A lane's connection can drop and reconnect alone. | Same. |
| Existing ingest room | No clash. | `roomName` must not end in `-ingest`, and the second room's name needs its own rule. |

Recommendation: **one room, one publisher participant per lane**. If measurement shows the extra data packets matter
at the listener counts in use (cost or CPU on the LiveKit instance), moving to two rooms is a contained change to the
publisher, the token endpoint and the page.

### Names

| | Lane 1 (first channel; today's names) | Lane 2 |
|---|---|---|
| Participant identity | `publisher-app` | `publisher-app-<id>`, for example `publisher-app-en` |
| Audio track name | `translation-audio` | `translation-audio-<id>` |
| Data topic | `captions` | `captions-<id>` |
| Publisher grant | publish, no subscribe, as today | same |

Listener tokens are unchanged: subscribe-only, `canPublish=false`, `canPublishData=false`, one fixed room, so a
listener who edits the URL gets the other channel's audio, which is public by design (both tracks are for the same
audience pool). Tracks are not secret from each other. If one channel must be private, that needs separate rooms and
tokens, and is outside this design.

The page's existing check that a data packet comes from `publisher-app` becomes a check against the identity of the
**selected** channel, so a listener's browser cannot be fed captions by another participant (listeners cannot publish
data anyway).

### Listener subscription

In a deploy with two lanes, `config.json` lists the channels (below) and the page connects with automatic subscription
off, then subscribes only to the track whose name matches the selected channel. In a one-lane deploy `config.json` has
no channel list and the page connects exactly as today (automatic subscription, same checks). The data packets need no
subscription: they arrive in the joined room.

## Captions per channel

### Events

The event schema stays v1, additive only ([architecture.md](architecture.md#event-contract-schema-v1)):

- **Channel 1 is unchanged**: same topic `captions`, same `channel`, `lang`, `id` and `seq`. Because it is a separate
  topic, a page from before this feature ignores everything of channel 2.
- Channel 2 events use topic `captions-<id>` and carry a new additive field `ch` (the channel id, `en`). They also carry
  `channel` and `lang` as today: `channel` and `lang` say which language the text is in (`caption`: the target
  language; `source`: the source language; `speech`: the as-said language), and `ch` says which listener channel the
  event belongs to. `ch` is omitted on channel 1 events so they stay byte-identical to today.
- Chunk ids of lane 2 are `<id>:<session>-<n>` (`en:1-12`), so ids stay unique across lanes in logs. Lane 1 keeps
  `<session>-<n>`.
- `seq` is monotonic per lane.

| Event | Channel 1 (`ja` listeners) | Channel 2 (`en` listeners) |
|---|---|---|
| `caption` | `channel:"ja"`, `lang:"ja"`, `sourceLang:"en"`, text = Japanese sent to Polly | `ch:"en"`, `channel:"en"`, `lang:"en"`, `sourceLang:"ja"`, text = English sent to Polly (before SSML) |
| `source` | `channel:"en"`, the English words as recognised | `ch:"en"`, `channel:"ja"`, `lang:"ja"`, the Japanese words as recognised (fillers removed) |
| `speech` | `channel:"ja"`, Japanese as said, `asSaid:true` | `ch:"en"`, `channel:"en"`, `lang:"en"`, English as said, `asSaid:true` |

`MAX_CAPTION_TEXT` stays 600 characters. The as-said tap's language check and the code that hides English fillers
(the existing `fillers` words) apply to lane 2's as-said English.

### Which area shows what

The two areas keep their place, size and number of lines. Their roles are named by role, not by language:

| Area | Channel 1 (today) | Channel 2 |
|---|---|---|
| **Target area** (large, up to 8 lines, above the source area) | Japanese translation and Japanese as said (`― `, blue) | English translation and English as said (`― `, blue) |
| **Source area** (small, `#555`, pinned near the bottom, 3 lines) | English source as recognised | Japanese source as recognised |

- `?source=off` hides the source area on either channel; the target area keeps its place and size.
- English text is wider per character than Japanese. The assembler's line-merging limits are per language: for the
  Japanese target area 60 characters (as today); for the English target area a limit that gives the same line width
  (about 110 characters, a starting value to confirm in the browser tests); for the Japanese source area the same
  rule that 240 English characters give today, expressed as about 90 Japanese characters. A sentence still ends a
  line at `。？！` or `.?!`; the fade and lifetime rules do not change.
- The as-said marker `― ` and the rule "a change of kind always starts a new line" apply to both channels. The
  "as-said waits for the open translated sentence, up to 3 s" rule works the same way.
- The English "as said" lines on channel 2 come from the same `speech` path: stable words of results the lane's gate
  classified as English and never forwarded, after the 3-item settle rule; a retract removes them if the result turns
  out to be Japanese.
- `lang` attributes: the target area gets `lang="ja"` or `lang="en"` and the source area the other, so a screen reader
  chooses the right voice. The target area stays `aria-live="polite"`, the source area `aria-live="off"`. Further
  accessibility work belongs to [#12](https://github.com/kuu/realtime-speech-interpreter/issues/12) and applies to both
  channels.

`captions=off` still turns off all captions of all channels; `captionsJapaneseSpeech` (as-said text) governs the as-said
text of every lane, see open question 4.

## Listener page and URL scheme

**One page, one button, the channel in the URL.**

| URL | Plays |
|---|---|
| `https://<host>/` | The default channel (the first one in `channels`) |
| `https://<host>/?ch=ja` | The channel whose target is Japanese |
| `https://<host>/?ch=en` | The channel whose target is English |
| `https://<host>/?ch=en&source=off` | English, with the source area hidden |

- `ch` is the channel id (the target language), because the listener thinks "I want English", not "Japanese to English".
- The venue prints two QR codes and posters, one URL each. The stack outputs the default URL as `ListenerUrl` (as
  today) and one output per additional channel (`ListenerUrlEn` for id `en`).
- The choice is read once at load. The page has no control to switch; to change channel the listener opens the other
  URL. The Listen button, status line and hint stay the only visible parts, in their present positions.
- Page text that names the language (the heading "Live Translation", the line under it, the status messages) is looked
  up from a small table by the channel's target language. It is text, not a control. The default page for one-lane
  deploys is the page that exists today, byte for byte, apart from the one table.
- **Unknown channel.** A `ch` value that is not in `config.json` shows "This channel is not available" in the status line
  and leaves Listen disabled. It does not fall back to another channel, because an English listener who is played
  Japanese would not know why. In a one-lane deploy, `?ch=<the only channel's id>` works and any other value is
  "not available". A deploy without the `channels` list treats the default as `ja`.
- The query is parsed with the same strict function as `source` (an allow-list of values from `config.json`), never put
  into the page as HTML, and never sent to the server.
- A listener who joins during a pause hears nothing from channel 2 until Japanese is spoken, as a human interpreter's
  channel would be quiet. Hearing the **original** speech when its language is the listener's own is out of scope: this
  mode assumes listeners in the venue, who hear the room and use the channel for the other language (open question 8).

`config.json` for a two-lane deploy (generated by the stack):

```json
{
  "livekitUrl": "wss://livekit.example.com",
  "tokenEndpoint": "/token",
  "captions": true,
  "defaultChannel": "ja",
  "channels": [
    { "id": "ja", "sourceLang": "en", "targetLang": "ja", "track": "translation-audio", "publisher": "publisher-app", "topic": "captions" },
    { "id": "en", "sourceLang": "ja", "targetLang": "en", "track": "translation-audio-en", "publisher": "publisher-app-en", "topic": "captions-en" }
  ]
}
```

With one default lane the file has no `channels` and no `defaultChannel`.

## Operator, doctor and e2e changes

### Operator ([operations.md](operations.md))

- A line in the event-day checklist: print one QR per channel, test each URL on a phone.
- Monitoring: the `[langfilter]` summary and `[chunk N]` lines carry `ch=<id>` when there are two lanes. New counters
  per lane: results routed, `lateSpoken`, retracts, drops by reason, translation fallbacks, chunks dropped by backlog.
  Nothing is added to the log line in a one-lane deploy.
- "If something breaks": channel 2 silent means look at its lane's lines first. Channel 1 is not affected by it
  (see [Failure isolation](#failure-isolation)).

### Doctor (`scripts/doctor.sh`)

Per channel: the Transcribe vocabulary exists in the right language and is READY; the terminology exists and has the
right language columns; the Polly voice exists in the Region for the engine; the Bedrock model is reachable when the
lane's engine is `llm`. A bilingual deploy without a Japanese vocabulary is a warning, not an error. Reads only,
never prints a secret.

### e2e ([e2e-testing.md](e2e-testing.md))

- The recorder subscribes to **both tracks** in a two-lane deploy and writes `translation-ja.wav` and
  `translation-en.wav` (the single-lane file keeps its name `translation.wav`).
- `report.md` gets one metrics block **per channel**: `e2eFirstWordMs` and `e2eLastWordMs` (avg, p50, p90, max),
  `commitLagMs`, `maxBacklogMs`, chunks by commit reason, played, dropped, skipped, failed, the LLM section, the
  language-filter section. Plus a bilingual block: routing counts, `lateSpoken`, retracts, and the first-chunk delay
  after each language switch.
- Reference script: `samples/scripts/qa-bilingual.txt` (English speaker, Japanese questions, fictional company) already
  exists and names the second channel as its purpose. It stays the primary bilingual test; a longer single-speaker
  Japanese sample is needed for the pure monologue measurement (open question 5).
- `e2e.sh run` keeps `--input srt|rtmps`; a `--channel <id>` option limits the report to one channel, the default is all.
- `./e2e/e2e.sh langscan` is unchanged; it finds language switches in a recording and is used to place measurement
  windows.

## Cost

Transcribe streaming is unchanged: one stream, billed by audio duration, whatever the number of lanes.

What grows with channel 2 is billed per **translated speech**, not per hour of session:

| Item | Growth with channel 2 |
|---|---|
| Transcribe | none |
| Translate / Bedrock | one call per Japanese chunk. LLM: calls scale with chunk count; the cached glossary is read on every call, so a second cache (the ja-to-en glossary) adds its own cache write once per start and its own keep-warm call (`llmKeepWarmMs`, 4 min). |
| Polly | English characters spoken. |
| Fargate | One task, a small increase of CPU and memory for a second lane. Check the task size in the e2e run. |
| LiveKit | A second published track (about 32 kbps) and the other lane's caption packets to every listener. Audio sent to listeners is unchanged: each listener subscribes to one track. |
| CloudWatch Logs | A few percent more lines. |

**Estimate method** (to be added to `docs/cost.md` and to `scripts/estimate-cost.mjs` when built):

```
extra per hour = f_ja x (chunks_per_hour_ja x (LLM_per_chunk or Translate_per_chunk) + polly_chars_per_hour_en x Polly_price)
                 + 2nd-glossary cache write and keep-warm
```

- `f_ja` is the share of the hour spoken in Japanese (a Q&A with Japanese questions: 0.1 to 0.3, a Japanese-led
  session: close to 1). It is an input, `--ja-share`.
- `chunks_per_hour_ja` and the English characters per Japanese character come from the e2e run on the bilingual
  samples. The English-to-Japanese ratio is not assumed here; it is a measured input.
- As a bound for planning, a lane that is busy all hour costs about what channel 1 costs today per hour for the speech
  services (Polly $0.398 and Bedrock $0.930 per hour in the current table, LLM engine, `talk` profile). With
  `f_ja = 0.25` that bound is about $0.33 per hour (*estimate*, list price, to be replaced by the measured value).
- The calculator gets `--channels` and `--ja-share`; the check against a measured case in `cost.md` is repeated for the
  bilingual sample.

## Latency: hypothesis and measurement plan

**Latency is the priority, so channel 2 has a stated hypothesis and a pass/fail test, not an assumption.**

### Where Japanese differs from English

| Stage | Channel 1 today (measured, `talk`) | Channel 2, from the probe data |
|---|---|---|
| Speaker says the chunk | about 3.2 s | The clause length at the cut: 0.2 to 1.1 s of speech for a stable `。`, up to the character cap (about 4 s) for unpunctuated speech |
| Transcribe stable | about 2.0 s | 2.9 s median (p90 4.6 s) between the audio position of a stable punctuation mark and its arrival |
| Translation (LLM) | about 0.5 s | Hypothesis: about the same (0.4 to 0.7 s); the output is longer |
| Polly | about 0.16 s | Hypothesis: 0.15 to 0.3 s for an English neural voice (measure; generative is slower) |
| Queue and network | about 0.2 s | same |
| After a language switch | n/a | the first result still carries the old language code for about 3.8 s |

### Hypothesis (to be tested, not a promise)

For channel 2 in a stretch of Japanese speech (not the first utterance after a switch), `e2eFirstWordMs`:
**p50 in 5 to 8 s, p90 up to 12 s**, that is about 1 s lower to 2 s higher than channel 1's 6 s at p50, and
clearly worse at p90, because (a) the stable-punctuation delay is a bit longer than the English stable-word delay, (b)
the verb-final order makes the clause-end the earliest sensible cut, and (c) 23% of results have no punctuation and wait
for rule 3, 4, 5 or 6. For the first utterance after a switch: add up to about 3.8 s (settle rule).

**Pass test for channel 2:** p50 of `e2eFirstWordMs` at most channel 1's p50 + 2 s on the same recording, p90 at most
12 s, `lateSpoken` at most 1 in 50 spoken chunks, and quality score no worse than a floor that the project owner sets
(open question 7). Failing means tuning the segmenter parameters, not accepting the latency.

### Method

1. **Replay, free.** The harness above on stored probe results. Gives the commit lag distribution per rule and the
   effect of `jaClauseMinChars`, `jaMaxChars`, `jaPauseMs` without touching AWS.
2. **Live, small.** The `qa-bilingual` sample through the real stack (or `e2e.sh local`) at both channels. Real
   Transcribe, Translate or Bedrock, Polly: billed at list price for the clip length. Run for each of three parameter
   sets; record per channel `e2eFirstWordMs`, `commitLagMs`, `lateSpoken`, first-chunk delay after a switch.
3. **Pure Japanese monologue.** The probe data is multi-language mode with short utterances. One 10-minute single-
   speaker Japanese recording through a stream in the production configuration (multi-language, as the app runs it)
   (about 10 min of Transcribe, roughly $0.24 at the list price used in the probe notes, not re-verified). Needs the
   owner's approval (question 5). It decides whether the character cap and rule 3 are right for long sentences.
4. **Per-chunk ground truth.** Each chunk logs the first and last source word's audio time (as today for English), so
   `e2eFirstWordMs` is source-time based and does not depend on listening.
5. **Report.** `e2e report` prints both channels side by side with the table above filled with measured values. The
   hypothesis row in this page is replaced by the measured row in the same pull request that builds the feature.

## Failure isolation

A channel-2 problem must not delay channel 1. This is by construction, and tested.

- **Separate objects.** Each lane has its own gate, segmenter, engine, player, queues, timers and LiveKit connection. A
  slow Japanese chunk waits in lane 2's queue only.
- **Event loop.** The Transcribe result handler calls each lane's gate synchronously; the gate does bounded work
  (no I/O) and **catches and logs every exception per lane** and carries on, so one lane's bug cannot stop the other's
  `onResult`. The ticker loop calls each lane's `tick` in its own `try/catch`, as it does today.
- **Slow I/O.** Translate, Bedrock and Polly calls are asynchronous and per lane; each has its own timeout and (for the
  LLM) its own circuit breaker. A Bedrock outage on lane 2 trips lane 2's breaker (its chunks go to Translate); lane 1's
  breaker stays closed. If both lanes use the LLM, they share the Bedrock client's connection pool: the client's
  concurrency limit is checked to be large enough for two lanes in the e2e run.
- **Backlog.** `maxBacklogMs` and speed control act per lane, so a backlog of English output drops English chunks only.
- **LiveKit.** Two participants: one drops and reconnects alone. A lane whose connection is down drops its chunks and
  logs; the other lane keeps playing.
- **Start-up.** If lane 2 fails to start (a missing voice, a missing terminology), the app **starts lane 1 anyway**,
  logs `lane en disabled: <reason>` as an error, and reports it on the health endpoint with a distinct field. It does
  not exit. A mis-set lane 1 still stops the app as today. (Open question 9 asks whether the owner prefers
  fail-fast.)
- **Transcribe.** One stream: a stream error ends and reopens it for both lanes together, as today. This is the one
  shared failure, and it is not a new one.
- **Test.** A fault-injection test: lane 2's engine hangs and throws; assert lane 1's chunk times are within noise of a
  run without lane 2.

## Single-channel parity

One channel configured must equal today's behavior exactly. The evidence is tests, not review:

- **Synth parity.** `cdk synth` for the default config and for `channels` with one default entry equals the golden
  (`cdk/test/fixtures/parity-*.json`) and the template from `origin/main` for the same context, in the ECS environment,
  IAM, security groups and outputs. No new environment variable appears (`CHANNELS` absent), no extra IAM statement,
  no `ListenerUrl<Id>` output.
- **App parity.** With no `CHANNELS`, config parsing returns one lane identical to today's; replaying a fixed result
  stream through the pipeline gives the same chunks, the same caption event bytes, the same log lines (a golden
  comparison, ignoring timestamps). The lane code path for one lane does not take the router.
- **Page parity.** With the default `config.json` (no `channels`), the page's DOM, CSS and script behavior are those of
  today; the existing page tests pass unchanged; `?source=off` and the layout tests (390x844, 390x664, 844x390,
  1366x768, 1920x1080) are unchanged.
- **Wire parity.** In a two-lane deploy, channel 1's audio, topic, identity, event bytes and caption order equal
  those of a one-lane deploy for the same input (checked in the e2e run: channel 1 chunk text and timing within noise).

## Acceptance criteria and tests

### Acceptance (all must hold)

1. One-channel configuration passes every parity check above.
2. Two-lane run on `qa-bilingual`: Japanese questions are translated and spoken on channel 2, English answers on channel
   1, each channel is silent during the other language's speech, and as-said text appears in the right area with the
   marker.
3. Product names in channel 2 output are identical to the English form in the dictionary; the check passes on the
   bilingual samples (no case where a source product name is missing or respelled in the English output).
4. Channel 2 latency passes the pass test in [Latency](#latency-hypothesis-and-measurement-plan), measured and written in
   the same page, per channel in `report.md`.
5. A forced channel-2 failure (engine hang, Polly error, LiveKit drop of lane 2) leaves channel 1's latency and output
   unchanged.
6. The listener page has only the Listen button; `?ch=en` plays English with the right areas; `?ch=xx` is "not available"
   with Listen disabled; layout tests pass on all listed viewports for both channels.
7. Cost: the per-hour estimate for the bilingual sample is in `cost.md`, computed by the calculator from measured inputs.
8. `check-publishable.sh`, `check-links.mjs`, docs tests and every existing test pass; `generate --check` on the example
   is unchanged.

### Test list

| Layer | Tests |
|---|---|
| Config (CDK) | default, one default entry, one non-default entry, duplicate sources, duplicate targets, same-language lane, source not in `languageOptions`, flat keys together with `channels`, unknown channel key, LLM lane without terminology, three channels; `CHANNELS` absent for the default; synth parity with `origin/main`. |
| Config (app) | The same rules from the shared validator; the app refuses an invalid list; lane 2 start failure leaves lane 1 running. |
| Router and gate | Both lanes receive every result; routing by final language; partial that flips (ja then en, en then ja); late flip with and without a spoken chunk (`lateSpoken`); split results (repeats) per lane; short interjections both ways; short-low-confidence rule for Japanese; the as-said tap per lane. |
| Japanese segmenter | Each rule alone (1 to 7) with synthetic Japanese; merge-short; dangling hold and release; no-punctuation text; character cap; invariants (no loss, no duplicate, retract, split results); fillers before translation; property test with random item streams. |
| Translation | Prompt builder for `ja` to `en` (snapshot of the template, glossary insertion, `chunk_ends_sentence`); name check and fallback; Translate request has no formality for an English target; terminology name per lane. |
| Polly | Voice and engine per lane; English readings applied, katakana never in English alias; unchanged for lane 1. |
| Dictionaries | New columns and flags parse; reserved-column note is gone only when the flags are implemented; generated files for a fixture; `generate --check`; validator rules; `dictionaries.sh --dry-run` lists the new uploads; example dictionary output unchanged. |
| Captions (app) | Event builders for lane 2 (`ch`, `channel`, `lang`, ids, topic); lane 1 bytes unchanged. |
| Page (unit and browser) | `?ch` parsing; unknown channel; track selection; sender and topic check per channel; assembler limits per language; layout on all viewports, both channels; `?source=off`; `textContent` only. |
| LiveKit | Two participants publish to one room; a listener subscribes to one track only (bytes received per track); data packets on the right topic; a lane's disconnect does not affect the other (local LiveKit). |
| e2e | `report.md` per channel; recorder with two tracks; `--channel`; fault injection on lane 2. |
| Doctor | Per-channel checks, warning without a Japanese vocabulary. |

## Open questions

Each has a recommended answer. The design assumes the recommendation until told otherwise.

1. **URL scheme.** `?ch=<target language>` on the one page, or a path (`/en/`)? *Recommended:* `?ch=en`. It needs no
   CloudFront or S3 change and matches `?source=off`.
2. **Default channel and legacy names.** The first channel in `channels` is the default and keeps `publisher-app`,
   `translation-audio` and `captions`. *Recommended:* yes; put Japanese first (as today). Order then decides which
   lane has the legacy names.
3. **English voice.** Which voice, and neural or generative? *Recommended:* a neural `en-US` voice that
   `describe-voices` lists for the stack's Region; consider generative only if its measured first-byte time is within
   0.1 s of neural and the voice is available there.
4. **As-said English on channel 2.** Show English speech in the English target area with `― `, controlled by the
   existing `captionsJapaneseSpeech` key? *Recommended:* yes, same key (its meaning becomes "speech in the listeners'
   language"); a per-channel switch only if someone asks.
5. **Pure Japanese measurement.** Approve one 10-minute single-speaker Japanese recording through a real stream (about
   $0.24 of Transcribe at the list price in the probe notes, plus Translate or Bedrock and Polly if run end to end)? Who
   records it (the sample must not contain a real attendee's voice without consent)? *Recommended:* yes, a script read
   by a colleague, synthetic content.
6. **Personal names in English output.** Western order (given name first) or as spoken? *Recommended:* Western order
   unless the dictionary says otherwise; names are rare and the check is simple.
7. **Quality floor for channel 2.** What is the minimum acceptable score on the judgement scale, and who scores?
   *Recommended:* the owner scores 30 chunks on the 1 to 5 scale used for the LLM benchmark; pass at the same median as
   channel 1 minus 0.5.
8. **Listeners.** Is the channel for listeners **in the venue** (they hear the floor audio themselves), or also remote
   listeners who would need the original speech when their own language is spoken? *Recommended:* in the venue only. A
   remote mix (original audio ducked under interpretation, a third track) is a separate issue.
9. **Lane start failure.** If lane 2 cannot start, start lane 1 anyway and say so (recommended), or refuse to start?
   *Recommended:* start lane 1; the event must not lose its main channel to an optional one. `doctor` catches it
   earlier.
10. **Translate terminology.** A second uni-directional terminology `<name>-ja-en` (recommended) or a single
    multi-directional terminology replacing the deployed one? *Recommended:* the second one, so nothing channel 1 uses
    changes.
11. **Per-lane chunk settings.** Should a channel have its own chunk and speed settings in `channels`? *Recommended:* not
    now; global keys plus the new `ja*` keys, add per-channel overrides when a measurement needs them.
12. **Unknown `?ch`.** Show "not available" and disable Listen (recommended), or fall back to the default channel?
    *Recommended:* not available. A fallback plays the wrong language without a hint.

## Not in scope

- A second Transcribe stream, per-microphone inputs, or more than two channels ([#19](https://github.com/kuu/realtime-speech-interpreter/issues/19)).
- Speaker labels ([#8](https://github.com/kuu/realtime-speech-interpreter/issues/8)). The design works without them and
  leaves a hook: a lane's gate can take a speaker-to-language hint later.
- Changes to the dictionary builder's suggestion heuristics beyond direction support ([#7](https://github.com/kuu/realtime-speech-interpreter/issues/7)).
- Accessible caption presentation beyond the `lang` and `aria-live` rules above ([#12](https://github.com/kuu/realtime-speech-interpreter/issues/12)).
- `architecture.drawio.svg`: the diagram is not changed by this design. When the feature is built, the diagram and the
  step table in [architecture.md](architecture.md) are updated in that pull request.
- Any deploy, `dictionaries.sh` run or other AWS change.
