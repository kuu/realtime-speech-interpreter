# Dictionaries

Technical talks are full of names and acronyms that speech recognition, translation and speech synthesis get
wrong. The project has four tools for this. Each one fixes a different stage.

| Stage | Tool | Fixes | File | Where it lives |
|---|---|---|---|---|
| Speech to text | Transcribe custom vocabulary | The word is not recognized ("verticalization" heard as "fertilization"). | `dictionaries/transcribe-vocabulary.txt` | Transcribe (uploaded by a script) |
| Text after recognition | Context corrections | A wrong word that is itself valid English ("ABC" for "AVC"). | `app/src/corrections.ts` | In the app (code) |
| Translation | Translate terminology | A term is translated badly or translated at all. | `dictionaries/translate-terminology.csv` | Translate (uploaded by a script) |
| Text to speech | Polly readings | Polly says a product name wrongly. | `app/assets/polly-readings.csv` | In the app image |

The files in `dictionaries/` and `app/assets/` are an example for AWS media services talks. Replace the
terms with your own subject.

## When to use which

1. **Start with the vocabulary.** Add product names, acronyms and jargon that the speaker will say. Keep it short.
   A long list lowers accuracy.
2. **Add a terminology entry** when the translation of a term must be fixed (or the English name must stay as it is).
   With `translateEngine=llm` the model gets the glossary from this terminology too.
3. **Add a context correction** when a recognition mistake survives the vocabulary. Look at `en=` in the log
   (`COMMIT` lines) to see what Transcribe actually heard.
4. **Add a reading** when the text is right but the voice pronounces it wrongly. Listen to the output first.

## Lessons learned

- **Vocabulary boosting is not enough for some terms.** "AVC" was still heard as "ABC" with the term in the vocabulary,
  and "HEVC" as "HEBC". Both are rare words next to very common ones. A context rule fixes them: "ABC" becomes "AVC"
  only when codec words are near ("encode", "HEVC", "H.264"), so "ABC News" stays. Keep rules conservative. A missed
  fix costs little. A wrong fix changes the meaning.
- **Some mistakes are real words.** "lunch" for "launch", "wrist" for "RIST". These need a context rule, because a plain
  replacement would break normal sentences.
- **Never change the product name in the text.** The text that is shown, logged and translated keeps the real spelling.
  Only the sound changes. Polly readings use SSML `<sub alias="reading">Term</sub>`, so the term stays in the text and
  only the alias is spoken. Adding spaces to a name or writing it in Katakana in the text is not acceptable. A Katakana
  alias is fine, because nobody sees it.
- **Check every alias by ear.** Polly can insert a pause where you do not expect one. In the example file the
  readings for `ST 2110` and `ST 2022-7` use a katakana long-sound spelling because the hiragana spelling made Polly pause
  after "に". A native speaker should review every reading.
- **Acronyms can need a rule per spelling.** `SCTE-35`, `SCTE 35` and `SCTE-104` each need a row, because the longest
  matching term wins.
- **Terminology is case-insensitive**, so each English term appears once.

## Rules for each file

`node dictionaries/validate.mjs` checks all three files against the Transcribe and Translate format rules and prints
line-numbered errors. Run it before every upload. Details of each format are in
[`dictionaries/README.md`](../dictionaries/README.md).

### Transcribe custom vocabulary

Tab-separated table with the header `Phrase`, `SoundsLike`, `IPA`, `DisplayAs`. Leave `SoundsLike` and `IPA` empty.
Words in `Phrase` are joined with hyphens. Spell out acronyms as `A.W.S.` and numbers in words. `DisplayAs` is the
form you want in the text (digits are allowed there).

### Translate terminology

CSV with the header `en,ja`, UTF-8 without BOM. An AWS service name usually stays in English. An overwrite can take up
to 10 minutes to take effect.

### Polly readings

CSV `term,reading` with `#` comment lines. The match is exact and case-sensitive, and the longest term wins.
Readings use Katakana, the long-vowel mark, spaces, digits and hyphens. Turn the feature off with
`"pollyReadings": false` in `event.json`.

### Context corrections

Rules in `app/src/corrections.ts`. Each rule has a pattern and a function that returns the replacement, or
`null` to leave the text alone. Add a unit test in `app/test/corrections.test.ts` that shows both the fix and a
sentence that must not change. The log line of a changed chunk ends with `[corrected: ABC -> AVC]`. The switch is
`ENABLE_CORRECTION` (`"advanced": {"enableCorrection": "false"}` in `event.json`).

## Publish

Dictionaries must be in AWS **before** the event. From the repository root:

```bash
node dictionaries/validate.mjs
cd cdk
./scripts/dictionaries.sh --restart-app
```

The script (needs AWS credentials for the same account and Region as the stack):

1. creates a private S3 bucket `simul-translation-dict-<account>-<region>` if it does not exist,
2. uploads the vocabulary, then creates or updates the Transcribe vocabulary `simul-translation` and waits for `READY`,
3. imports the Translate terminology `simul-translation` (overwrite),
4. with `--restart-app`, restarts the Fargate task so it loads the new dictionaries.

Env variables: `AWS_REGION` (default `ap-northeast-1`), `DICT_NAME` (default `simul-translation`), `DICT_DIR`
(default `dictionaries/` of this repository), `STACK_NAME`. If you change `DICT_NAME`, set the same names in
`event.json` (`dictionaries.transcribeVocabulary` and `dictionaries.translateTerminology`) and deploy.

Polly readings and context corrections ship in the app image. After editing them, run `npx cdk deploy` from `cdk/`.
