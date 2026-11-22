# monologue-ja: notes
One Japanese speaker (voice Takumi), about 3 minutes of speech, fictional company "Lumenstream". It has no English speech, so
it measures the Japanese-source lane (channel 2, Japanese to English) alone: no language switches, no gate drops, long
sentences with `、` and product names in Latin letters (`Lumenstream Live`, `Lumenstream Low Latency`, `SRT`).

This repository does not contain a recording of it. The owner reads the script aloud or generates the audio with
`./samples/make-samples.sh monologue-ja`, then runs `./e2e/e2e.sh run <recording> --japanese-only` against a two-channel (or
`ja-JP` to `en` single-channel) deploy. The run is not part of the automated tests.

Expected behavior: every sentence is translated and spoken on channel 2; channel 1 stays silent (no English speech). With
`jaSegmentationMode=simple` the cuts are at `。`, at each `、`, after `jaMaxWaitMs` and at the final. Run once with `simple`
and once with `full`, then `./e2e/e2e.sh compare <run A> <run B>` prints the Japanese segmentation reasons side by side.

Suggested English reference, first sentences:
1. "Hello everyone. Today I will introduce Lumenstream's new streaming service, Lumenstream Live."
2. "This service is a mechanism for delivering the video and audio of a venue straight to the internet."
3. "The delay is about three seconds in the normal setting."

The report writes `scoring-sheet.md` with 30 evenly chosen chunks (source, translation, an empty score column). Score each
translation 1 to 5; the quality floor is the median of channel 1 minus 0.5.
