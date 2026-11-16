# Roadmap

Five features were planned. Each section below was written so it can be pasted into a GitHub issue. Feature 1 is done; the others are open.
The order is a suggestion: 1 and 4 are small and independent; 2 and 3 share a "who is speaking" and "which language"
model; 5 changes the ingest path and the security model. Feature 1 is implemented; 2 to 5 are not.

Component names refer to files in `app/src/` (for example `pipeline.ts`, `language-gate.ts`, `chunk-player.ts`,
`livekit-sink.ts`) and the listener page in `app/web/`.

---

## 1. Dictionary builder (done)

**Status.** Implemented: `node dictionaries/build.mjs` with `generate`, `suggest`, `merge` and an optional
`--suggest-with-bedrock`, from one `terms.csv` source. See [dictionaries.md](dictionaries.md). The text below is the
original plan.

**Problem.** Building the Transcribe vocabulary, Translate terminology and Polly readings by hand (see
[dictionaries.md](dictionaries.md)) is slow and is the main customization step for each event.

**Proposal.** A command, for example `node dictionaries/build.mjs --from slides.pdf|notes.txt|transcript.txt`, that
extracts candidate terms (product names, acronyms, names) from the input, proposes the entries for the three
dictionaries, and writes a reviewable diff. Never overwrites the existing files without confirmation. An optional
mode asks a Bedrock model for Japanese translations and readings and marks them as unverified. A second input is the
app's own log: list English words that were frequently corrected or misheard in a rehearsal.

**Acceptance criteria.**
- Input of a text file produces a candidate list with one line per term and the source line of each.
- Output passes `node dictionaries/validate.mjs`.
- Product names are never changed or respelled (only the spoken alias differs); a test covers this.
- No AWS calls unless an explicit flag is given; documented cost of that mode.

**Not in scope.** Automatic upload to Transcribe/Translate (stays in `cdk/scripts/dictionaries.sh`).

## 2. Speaker-aware voices

**Problem.** In round tables and fireside chats, one voice for everybody makes it hard to follow who speaks.

**Proposal.** Detect the speaker and choose a Polly voice per speaker. Start with Transcribe streaming speaker
partitioning (check current language support for English first), assign voices from a configured list in order of
first appearance, keep the mapping for the session, and make the mapping overridable in the event file.

**Open questions.** Accuracy of live speaker labels on a single mixed channel; behavior when two people talk at once;
how to avoid a voice change in mid-sentence (label arrives late). A fallback to the single configured voice must always
exist.

**Acceptance criteria.**
- Config: `speakerVoices: ["Takumi", "Kazuha"]` or similar; unset means today's behavior (tested).
- A chunk never changes voice mid-chunk; label changes apply from the next chunk.
- The e2e report shows chunks per speaker label.
- Document the extra Transcribe cost, if any.

**Depends on.** Nothing. Feeds feature 3 (language per channel) and 4 (speaker names in captions).

## 3. Two-channel bilingual mode

**Problem.** Q&A with several languages: the English-to-Japanese direction ignores Japanese speech; the opposite
direction does not exist.

**Proposal.** Run two pipelines on the same audio. Channel 1 (for Japanese listeners) translates English to Japanese
and drops Japanese. Channel 2 (for English listeners) translates Japanese to English and drops English. The existing
language gate (`language-gate.ts`) already filters by language; a second instance with swapped source and target is the
core of the change. Publish each channel as its own LiveKit track or room, and show a channel switch on the listener page.

**Open questions.** Transcribe language identification latency when the language switches; Polly voice choice for
English output; cost roughly doubles for Transcribe language identification and Polly only for the spoken language (to
be measured, then documented in [cost.md](cost.md)); dictionaries per direction.

**Acceptance criteria.**
- Config selects `channels: [{source: en, target: ja}, {source: ja, target: en}]`; one channel configured equals today.
- Each channel ignores speech in its target language (tested with a mixed sample from `samples/`).
- Listener page offers a channel choice and remembers it.
- `samples/scripts/qa-bilingual.txt` is the test input.

## 4. Captions with audio (done)

**Shipped.** After **Listen** is pressed, the page shows Japanese captions when their audio starts and the English
source as it is recognised (`?source=off` hides it). Data goes as reliable LiveKit data packets from the app; listener
tokens still cannot publish. The deploy setting `captions` (default `on`) turns it off. The event schema has `channel`
and `speaker` fields for items 2 and 3. Details: [architecture.md](architecture.md#captions).

**Accessible captions (issue #12), first step: done.** Japanese speech is shown as said (`― ` marker, untranslated,
never spoken) in the Japanese area, interleaved with the translations; `captionsJapaneseSpeech` turns it off. The
caption areas now have fixed positions (Japanese large and bottom-anchored under the hint, English pinned near the
bottom). Speaker labels ("Speaker 1", "Audience") come later with #8: the events already carry `speaker`.
**Not built, on purpose.** A toggle and a size setting on the page: the page keeps only the **Listen** button. The
on-page machine-translation notice from [security.md](security.md) is still open.

## 5. Browser microphone ingest

**Problem.** Some venues have no audio line out or do not allow bringing a PC that runs OBS.

**Proposal.** A page, protected by a separate publish token, that captures the microphone with `getUserMedia`, and sends
it to the app through LiveKit (as a publisher with a limited token) or WebSocket. The app receives it as another audio source
next to SRT (`srt-source.ts`) and feeds the same decoder and pipeline.

**Security questions to answer first.** Who may publish (a long random link per event, expiry, one publisher at a
time); HTTPS is required for `getUserMedia`; the token endpoint must not hand out publish rights to listeners
(see [security.md](security.md)). The venue IP restriction does not apply to browsers, so the risk model changes: add it
to `docs/security.md` before shipping.

**Acceptance criteria.**
- Only a holder of the publish link can send audio; listener tokens still cannot publish (test).
- The same pipeline settings apply as for SRT; the e2e harness can feed a file through this path.
- Echo and feedback guidance in the docs (headphones for the speaker, not the audience).
- Latency compared with SRT and reported in [architecture.md](architecture.md).

---

## Cross-cutting items

- Model upgrade: when Claude Haiku 4.5 is retired, use the `model_upgrade` issue template and the e2e runner to compare
  quality and first-word latency.
- Language pairs other than English to Japanese: Polly voice, Transcribe language and dictionaries are configurable
  today; the prompt and the readings logic are not yet tested for other pairs.
- Tiers of `expectedListeners` (see [configuration.md](configuration.md)) are estimates and have not been load-tested.
