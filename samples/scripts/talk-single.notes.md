# talk-single: expected translation notes

Ground truth for the spoken English is `talk-single.txt` (exactly what Polly reads, in order). One speaker
(Matthew), about 2 minutes, 8 paragraphs.

Expected behavior of the translation (English to Japanese):

- Every paragraph is translated; nothing is dropped. The Japanese-speech filter must not fire (no Japanese in the audio).
- Product and technical terms stay recognizable and are not mangled by Transcribe: `Lumenstream` (fictional product,
  keep as is), `SRT`, `HLS`, `DASH`, `CDN`/`multi-CDN`, `SDK`, `Kubernetes`, `p99 latency`, `bitrate ladder`, `ingest`,
  `transcode`, `failover`, `manifest`, `observability`.
- "Three building blocks" (ingest, packaging, delivery) must keep the order and the count in the Japanese output.
- Numbers: "a million viewers", "one second" segments, "two-hour event", "three building blocks".
- Lessons paragraph: "First / Second / Third" enumeration is preserved.
- Good test of dictionary effect: add terms such as `bitrate ladder`, `ingest`, `failover` to your terminology CSV and
  compare two runs with `./e2e/e2e.sh compare`.

A usable translation does not have to match any particular Japanese wording; judge meaning, term handling and order.
