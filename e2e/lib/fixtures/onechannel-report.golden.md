# E2E run report: golden

- Mode: **local** (app run locally with INPUT_FILE + file sink, real AWS AI services)
- Recording: `None`
- Clip: start 0:00 (0.0 s), duration 60.0 s
- Run started: 2026-11-12T06:00:00Z  ·  folder `run1`

Files: `translation.wav` (Japanese output, sample 0 = stream start), `source-clip.wav` (English input), `side-by-side.wav` (left = source, right = translation, time-aligned), `app.log`, `report.md`.

## Settings in effect (from the app's startup log lines)

| Setting | Value |
|---|---|
| langfilter.mode | `langid` |
| langfilter.options | `en-US,ja-JP` |
| langfilter.settleWords | `5` |
| langfilter.shortWords | `4` |
| langfilter.shortMinConf | `0.6` |

## Summary

| Metric | Value |
|---|---|
| Chunks committed | 1 |
| COMMIT reasons | sentence=1 |
| Played / dropped / skipped / failed | 1 / 0 / 0 / 0 |
| e2eFirstWordMs avg / p50 / p90 / max | 6000 / 6000 / 6000 / 6000 |
| sentenceStartLagMs avg / median / p90 (sentences) | 6000 / 6000 / 6000 (1) |
| e2eLastWordMs avg | 1000 |
| e2eLastWordMs p50 / p90 / max | 1000 / 1000 / 1000 |
| commitLagMs avg / p90 | 400 / 400 |
| maxBacklogMs (SYNTH/DROPPED) | 600 |
| Speed rate histogram (SYNTH rate=) | 100%: 1 |
| Speed level histogram (SYNTH level=) | - |
| Level changes (per min) / max jump | - |
| Rate changes (per min) / max jump (pts) | 0 (0.0/min) / 0 |
| Speed decisions (speedWhy) | - |
| Median words per chunk | 9 |
| Fragmentation: dangling ends / continuations / <= 3 words | 0 / 0 / 0 |
| Japanese audio played | 1.0 s |
| Rows flagged as possibly non-English | 0 |
| ERROR / RtcError lines | 0 |

## Sentence start lag

sentenceStartLagMs = e2eFirstWordMs of the first chunk of each sentence (first chunk of the run, or the first chunk after one whose English ends in . ? !): first English word of the sentence to first Japanese sound. Stage means split e2eFirstWordMs: span = first to last English word of the chunk, commitLag = last word to COMMIT, workerWait = COMMIT to start of translation, translate, synth (Polly), sinkWait = earlier Japanese audio still playing (sinkWait is estimated from sinkQueuedMs; see `stage_breakdown` in report.py).

| Metric | Value |
|---|---|
| sentenceStartLagMs avg / median / p90 / max (count) | 6000 / 6000 / 6000 / 6000 (1) |

| Mean ms per stage | span | commitLag | workerWait | translate | synth | sinkWait | = e2eFirstWordMs | chunks |
|---|---|---|---|---|---|---|---|---|
| Sentence-start chunks | 5000 | 400 | 400 | 100 | 100 | 0 | 6000 | 1 |

## Fragmentation

| Class | Chunks |
|---|---|
| Dangling end (ends on a preposition/article/relative word without .?!) | 0 |
| Continuation (lowercase start after a chunk without .?!) | 0 |
| Tiny chunks (<= 3 words) | 0 |

## Speed timeline

One line per source minute (mm:00 = minute of the recording), one glyph per synthesized chunk on a fixed scale ▁ = 100% … █ = 150%; in brackets the level (Lx, ! = urgent jump), or the rate % for logs without levels.

```
00:00  ▁  (100)
```

## Possible Japanese / non-English speech

Flags: `ja-chars` = Japanese characters in the English transcript; `romaji` = romanized Japanese words; `low-english` = few English function words (typical of Transcribe en-US output for Japanese speech); `langscan-ja` = overlaps a range that `e2e.sh langscan` (Transcribe language ID) labelled ja-JP. Heuristic flags can be false positives: confirm by listening to `source-clip.wav` at the given time.

(no rows flagged)

## Language filter

Transcribe results dropped before translation (`[langfilter] dropped`). A drop that overlaps a `langscan` ja-JP range (±0.5 s) is a correct drop; a drop with no overlap is a suspected false drop of English: listen to `source-clip.wav` at that time.

| Metric | Value |
|---|---|
| Dropped results | 2 (non-english=1, short-low-conf=1) |
| Dropped words | 8 |
| Correct / suspected false drops | no language-scan data (run `e2e.sh langscan`) |
| Played chunks overlapping langscan-ja | 0 |
| `[verify]` OK / MISMATCH / LANGDROP | 1 / 0 / 1 |

| Source time | Reason | Lang | Words | Conf | langscan-ja | Text (Transcribe) |
|---|---|---|---|---|---|---|
| 0:00–0:06 | non-english | ja-JP | 7 | 0.91 | - | はい、それでは始めます。 |
| 0:19–0:20 | short-low-conf | en-US | 1 | 0.50 | - | more. |

## Chunks

Source time = position in the recording. e2e = e2eFirstWordMs (first English word spoken → first Japanese sample heard). Rate = Polly speed (%). Lvl = speed level (SPEED_MODE=levels; steps mode logs 1 + steps applied). Speed timeline = rate glyph (▁ 100% … █ 150%), level, ↑/↓ vs the previous synthesized chunk, ! = urgent jump.

| # | Source time | Reason | EN | JA | Rate | Lvl | Speed timeline | e2e ms | Status | Flags |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0:07–0:12 | sentence | Thank you for coming to this session today, everyone. | 本日はお越しいただきありがとうございます。 | 100 |  | ▁ | 6000 | played |  |

## HUMAN JUDGEMENT

<!-- HUMAN-JUDGEMENT-START -->
Fill this in after listening to `translation.wav` / `side-by-side.wav` (or live on the listener page).
Scores: 1 = unusable, 3 = acceptable, 5 = as good as a human interpreter.

| Criterion | Score (1-5) | Notes |
|---|---|---|
| Accuracy (meaning preserved) |  |  |
| Fluency (natural Japanese) |  |  |
| Latency (lag acceptable) |  |  |
| Naturalness of speed |  |  |
| Japanese speech ignored (no output for JA moderator/audience) |  |  |
| Overall |  |  |

Listener:
Date:
Notes:
<!-- HUMAN-JUDGEMENT-END -->
