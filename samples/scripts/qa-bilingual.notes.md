# qa-bilingual: expected translation notes

Ground truth is `qa-bilingual.txt`: an English speaker (Matthew) answers, and Japanese audience questions are read by
Japanese voices (Takumi, Kazuha, Tomoko). The Japanese text of each question is in the script, and the generated
`out/qa-bilingual.timeline.tsv` gives the timing.

Expected behavior today (channel 1, English to Japanese): the 4 English paragraphs are translated; the 4 Japanese questions
are ignored by the Japanese-speech filter (no Japanese-to-Japanese echo, no translation attempt, no spoken output for them).

Expected behavior with the future two-channel work: channel 2 (Japanese to English) translates only the 4 Japanese questions
and ignores the English answers; channel 1 does the reverse. Suggested English reference for the questions:

1. "Excuse me, I have a question. How short can the delay of live streaming be?"
2. "Thank you. When you use multiple CDNs, how do you manage the cost?"
3. "Can viewers watch stably even at a venue with a weak mobile connection?"
4. "Finally, do you support Japanese subtitles?"

Check also that language switches do not cut an English sentence in half and do not leave stale text in the chunker.
