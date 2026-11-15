# dialogue-two-speakers: expected translation notes

Ground truth for the spoken English is `dialogue-two-speakers.txt`. Two speakers with different voices alternate:
Joanna (host "Jordan") and Matthew (guest "Sam"). `out/dialogue-two-speakers.timeline.tsv` (generated) gives start/end
seconds and the voice of every turn, so speaker-change detection can be scored against it.

Expected behavior today (single voice output): all turns are translated in order. Short turns ("Thanks for having me,
Jordan.") must not be merged into a wrong sentence or lost.

Expected behavior with the future multi-speaker work: the speaker change at every turn boundary is detected (13 turns,
12 changes), and the host and the guest are spoken with different Polly voices, consistently across the whole session.

Terms: `Lumenstream` (fictional company, keep as is), `CDN`, `manifest`, `encoder`, `ingest`, `failover`, `latency`.
Numbers: "six second segments", "one second segments", "six times more requests", "a million viewers", "more than half".
