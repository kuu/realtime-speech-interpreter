# Dictionaries

Technical talks are full of names and acronyms that speech recognition, translation and speech synthesis get
wrong. The project has four tools for this. Each one fixes a different stage.

| Stage | Tool | Fixes | File | Where it lives |
|---|---|---|---|---|
| Speech to text | Transcribe custom vocabulary | The word is not recognized ("verticalization" heard as "fertilization"). | `transcribe-vocabulary.txt` | Transcribe (uploaded by a script) |
| Text after recognition | Context corrections | A wrong word that is itself valid English ("ABC" for "AVC"). | `app/src/corrections.ts` | In the app (code) |
| Translation | Translate terminology | A term is translated badly or translated at all. | `translate-terminology.csv` | Translate (uploaded by a script) |
| Text to speech | Polly readings | Polly says a product name wrongly. | `polly-readings.csv` | In the app image |

The Translate terminology is also the glossary the LLM translator reads when `translateEngine=llm`, so one file
serves both.

You do not write these three files by hand. You keep **one source file, `terms.csv`**, and a command generates the
three files from it.

## Where your dictionary lives

| Folder | In git? | What it is |
|---|---|---|
| `dictionaries/example/` | yes | The example for AWS Elemental Media Services talks: `terms.csv` and the three generated files. |
| `dictionaries/local/` | **no** (gitignored) | Your own dictionary, same structure. Create it with `node dictionaries/build.mjs init`. |
| anywhere you like | your choice | Point `dictionaryDir` at it (see [Keeping your dictionary elsewhere](#keeping-your-dictionary-elsewhere)). |

Every tool picks the folder in the same order: the explicit setting (`dictionaries.dir` in `event.json`,
`-c dictionaryDir=...`, `--dir`, or the environment variable `DICTIONARY_DIR`), then `dictionaries/local/` if it
exists, then `dictionaries/example/`. A setting that names a folder that does not exist is an error. It never falls
back. `node dictionaries/build.mjs where` prints the folder in use. `./scripts/doctor.sh` prints it too and warns when
it is the example.

## Workflow

```bash
node dictionaries/build.mjs init                      # copy the example to dictionaries/local/ (or: init --empty)
node dictionaries/build.mjs suggest --from notes.md --from slides.pdf --from-log app.log
# open dictionaries/local/terms.proposed.csv: fill ja and reading, set the flags, delete rows you do not want
node dictionaries/build.mjs merge                     # shows the rows, asks before adding them to terms.csv
node dictionaries/build.mjs generate                  # writes the three files and validates them
cd cdk && ./scripts/dictionaries.sh --dry-run         # shows what would be uploaded; no AWS call
cd cdk && ./scripts/dictionaries.sh --restart-app     # uploads the vocabulary and the terminology
```

1. **`init`** makes `dictionaries/local/terms.csv`. Start from the example, or with `--empty` from a header only.
2. **`suggest`** reads your material and writes a proposal. It never changes `terms.csv`.
3. **Review** the proposal by hand. This is where the Japanese wording and the readings get decided.
4. **`merge`** appends the reviewed rows to `terms.csv`. It lists them and asks first. Without a terminal it stops
   unless you pass `--yes`.
5. **`generate`** writes `transcribe-vocabulary.txt`, `translate-terminology.csv` and `polly-readings.csv`, and runs
   the validator on them before it replaces any file. `generate --check` fails if the files on disk differ from what
   `terms.csv` produces (CI runs it on the example). Never edit the three generated files by hand.
6. **Publish.** `dictionaries.sh` uploads the vocabulary and the terminology. The Polly readings ship **in the app
   image**, so redeploy (`npx cdk deploy`) only when the readings changed. A vocabulary or terminology change needs no
   deploy, only `dictionaries.sh --restart-app`.

## terms.csv

One row per output entry. UTF-8 CSV, header row first. It opens in a spreadsheet; a field that contains a comma
(usually `notes`) is quoted.

**Why CSV, not YAML.** Every field is a flat string, a reviewer wants to see the rows side by side in a spreadsheet,
and `suggest` appends rows without touching the rest of the file. Nothing here needs nesting.

| Column | Meaning |
|---|---|
| `en` | **Required.** The English spelling. It is the terminology `en`, the Polly term and the Transcribe `DisplayAs`. It is never respelled. |
| `ja` | The Japanese target spelling. Product names keep their English spelling. Needed when `translate_en_ja=y`. |
| `reading` | The spoken form in katakana, used only as the Polly alias. Needed when `polly_ja=y`. |
| `transcribe_en` | `y` or empty. Write a Transcribe vocabulary row (en-US). |
| `translate_en_ja` | `y` or empty. Write a Translate terminology row (English to Japanese). |
| `polly_ja` | `y` or empty. Write a Polly reading (used when the app speaks Japanese). |
| `phrase` | Transcribe `Phrase`. Empty means it is derived from the display form (see the rules below). |
| `display_as` | Transcribe `DisplayAs`. Empty means `en`. |
| `notes` | Free text. |
| `source` | Where the term came from, for example `notes.md:12`. |
| `transcribe_en_pos`, `translate_en_ja_pos`, `polly_ja_pos` | Optional whole numbers: the row's position in that output. Rows with a number come first, in numeric order, then the rest in file order. Normally you leave them empty. They exist so the example reproduces the original files byte for byte. The LLM prompt lists the glossary in terminology order, so the order is part of the behavior. |

`SoundsLike` and `IPA` do not appear: Transcribe no longer uses them and the validator requires them to be empty.

**Both directions.** The flag names say their direction (`translate_en_ja`) and the text columns are neutral (`en`,
`ja`). The Japanese to English direction ([#9](https://github.com/kuu/realtime-speech-interpreter/issues/9)) uses the
flag `polly_en` in this same file, with the optional columns `transcribe_ja`, `translate_ja_en`, `reading_en`, `phrase_ja`,
`ja_variants` and the `*_pos` columns `transcribe_ja_pos`, `translate_ja_en_pos`, `polly_en_pos`. All of them are optional: a
`terms.csv` without them is valid. The builder writes `transcribe-vocabulary-ja.txt` when at least one row has a `reading`, and
`polly-readings-en.csv` only when a row has `polly_en=y` (design: [bilingual-channels.md](bilingual-channels.md#dictionaries-per-direction)).
Any other unknown column is an error, so a typo does not go unnoticed.
**Rules.**

- A flag set without its required field is an error that names the line. A row is never skipped silently.
- `en`, `ja`, `reading`, `phrase` and `display_as` must not contain a comma, a double quote, a TAB or a newline,
  because the generated files cannot quote them. Spaces are trimmed and runs of spaces become one.
- Several rows may share an `en` only as alias rows: the later rows set `transcribe_en=y` and a `phrase`, and leave
  `ja` and `reading` empty. This is how `MediaPackage v2` gets the two spoken forms "V. two" and "version two".
- Terminology uniqueness is case-insensitive. Polly uniqueness is exact. Transcribe phrases are unique,
  case-insensitively.
- A Transcribe phrase is derived from the display form: an all-caps word of 2 to 6 letters becomes `A.B.C.`, a
  CamelCase word is split (`Media-Package`), and words are joined with `-`. A word with digits or other characters has
  no automatic phrase, so write `phrase` yourself and spell the number out (`S.T.-twenty-one-ten`).

Example rows (columns in the order of the header above):

| Row | What it does |
|---|---|
| `AWS Elemental MediaPackage,AWS Elemental MediaPackage,AWS エレメンタル メディアパッケージ,y,y,y` | All three outputs. The phrase is derived (`A.W.S.-Elemental-Media-Package`). The reading is only the Polly alias. |
| `HDR,HDR,エイチディーアール,y,y,y` | An acronym: the phrase is `H.D.R.`. |
| `SCTE-35,SCTE-35,スカティ さんじゅうご,y,y,y,S.C.T.E.-thirty-five` | Digits in the name: `phrase` is written out. |
| `verticalization,バーティカライゼーション,,y,y,` | Transcribe and Translate, no Polly reading. |
| `Speke,,,y,,,speaky,SPEKE` | An alias row: Transcribe also hears "speaky" and shows `SPEKE`. |
| `Zixi,,ジクシー,,,y` | Polly only. |

**Product names are never changed or respelled.** `en` is copied unchanged into the vocabulary `DisplayAs`, the
terminology `en` and the Polly term. Only the Polly alias in `reading` changes how a term sounds, and nobody sees it.
`suggest --suggest-with-bedrock` keeps this rule in code: a term with a capital letter or a digit gets `ja` equal to
`en`, whatever the model answers. Tests: `dictionaries/test/generate.test.mjs` and `bedrock.test.mjs`.

## The reverse direction (Japanese speech to English)
For the two-channel mode ([bilingual-channels.md](bilingual-channels.md)) `terms.csv` takes more optional columns, so one file
still feeds every generated dictionary:

| Column | Meaning |
|---|---|
| `transcribe_ja` | Not needed: every row with a `reading` (or `phrase_ja`) is in `transcribe-vocabulary-ja.txt` (Transcribe ja-JP). `Phrase` = `phrase_ja` if set, else `reading` with spaces as hyphens; `DisplayAs` = `en`. `n` leaves the row out. |
| `translate_ja_en` | No effect on the file: there is one multi-directional terminology (below). `n` is accepted and only produces a warning, `y` on a row without `translate_en_ja=y` is ignored with a warning. |
| `polly_en` | `y`: a row in `polly-readings-en.csv` (`en,reading_en`) for the English voice. |
| `reading_en` | The spoken English alias; English letters only, no katakana. Required with `polly_en=y`. |
| `phrase_ja` | Optional Japanese `Phrase` (hiragana, katakana, kanji, `ー`, hyphen between words). |
| `ja_variants` | Other Japanese spellings of the same `en`, separated by `\|`. |
| `transcribe_ja_pos`, `translate_ja_en_pos`, `polly_en_pos` | Position in the generated file, as for the other `*_pos` columns. |

**One terminology for both directions.** `translate-terminology.csv` (header `en,ja`, the `translate_en_ja=y` rows) is imported by
`cdk/scripts/dictionaries.sh` with `Directionality=MULTI`, so the Japanese to English channel uses the same resource: Translate
reads it in reverse, and the LLM glossary reads the same file with the columns swapped. The en to ja entries are unchanged. If
several English terms map to one Japanese term (`channel`, `channels`), the reverse direction uses the row with `display_as` set,
else the first in file order, and `generate` prints a warning that lists them. Re-importing over an existing uni-directional
terminology is not documented to change its directionality, so the script asks before it deletes and re-creates it (`--yes` skips
the question; `--dry-run` shows the plan). Details: [bilingual-channels.md](bilingual-channels.md#translate-terminology-one-multi-directional-resource).
**Japanese vocabulary.** It is uploaded as `<name>-ja` (ja-JP) by the same script (override the name with `DICT_NAME_JA`). The
`ja-JP` channel in `event.json` takes it with `transcribeVocabulary` (optional; the script prints the name) and uses the shared
terminology by default. A reading that is no valid ja-JP `Phrase` (digits, Latin letters) or repeats an earlier one is left out
with a warning; set `phrase_ja` on that row or `transcribe_ja=n`. Product names keep their English spelling as the target and
are never respelled; katakana appears only in `reading` and `phrase_ja`.
**Caveat for the Japanese vocabulary.** The Transcribe page on character sets lists hiragana, katakana, kanji and full-width capital
letters as supported for `DisplayAs` in ja-JP. `DisplayAs` = the English name is outside that set, so `validate.mjs` prints a warning
and the first upload is the test: create the vocabulary once and check that its state is `READY`. If it fails, remove `DisplayAs`
and let the glossary map the transcript form back to the English name.

## suggest: candidate terms from your material

```bash
node dictionaries/build.mjs suggest --from notes.md --from slides.pdf --from-log app.log [--dir D] [--out FILE] [--force]
```

Inputs: plain text, Markdown (syntax and URLs are dropped), slide notes saved as text, transcripts, and PDF. PDF needs
`pdftotext` (macOS: `brew install poppler`; Debian and Ubuntu: `apt install poppler-utils`). Without it the PDF is
skipped with that hint and the command still works on the other inputs. `--from-log` reads the app log of a
rehearsal: the English text of the `COMMIT` lines is searched like any other text, and every word that
`corrections.ts` replaced (`[corrected: fertilization -> verticalization]`) is proposed with a note on what was heard
and how often.

What counts as a candidate: CamelCase names (`MediaPackage`), all-caps acronyms (`HLS`), letters with numbers
(`ST 2110`, `SCTE-35`, `H.264`, `M3U8`), capitalised multi-word names (`AWS Elemental MediaPackage`), capitalised names
that are not common words, and lowercase words of eight or more letters that are not common words (listed last). A
term already in `terms.csv` (compared case-insensitively against `en`, `phrase` and `display_as`) is left out.

The output is `terms.proposed.csv` in the dictionary folder: the same header as `terms.csv`, one line per term,
`source` set to the first `file:line` (`deck.pdf:p3:12` for a PDF), `ja` and `reading` empty, and `transcribe_en=y`
filled in when a phrase can be derived. `notes` says what kind of term it is, how often it occurs and where else. The
order is by score, then by first appearance, so two runs give the same file. An existing proposal is only replaced with
`--force`.

**Word list.** The builder skips ordinary words with `dictionaries/lib/common-words.txt`: about 2,700 everyday English
base forms, one per line, sorted. It was written for this project from general knowledge of English. It is not copied
or derived from any third-party word list or corpus, so it carries no extra license. Plurals and other inflections are
handled in code. Add your own words with `--wordlist FILE`.

A short run on the fictional announcement in `dictionaries/test/fixtures/announcement.md` (the first lines of the
output):

```text
18 candidate terms written to dictionaries/local/terms.proposed.csv (terms.csv was not changed)
  AWS Elemental MediaPackage  name           x2   dictionaries/test/fixtures/announcement.md:4
  Maria Lindqvist             name           x2   dictionaries/test/fixtures/announcement.md:6
  Northwind Media             name           x1   dictionaries/test/fixtures/announcement.md:3
  AuroraLive                  camelcase      x3   dictionaries/test/fixtures/announcement.md:1
  ST 2110                     letters-number x2   dictionaries/test/fixtures/announcement.md:7
  HLS                         acronym        x2   dictionaries/test/fixtures/announcement.md:6
  transmuxing                 rare-word      x1   dictionaries/test/fixtures/announcement.md:8
```

### Optional: Japanese and readings from Bedrock

```bash
node dictionaries/build.mjs suggest --from notes.md --suggest-with-bedrock [--model ID] [--region R] [--max-terms 50]
```

Off by default. Without the flag the command makes **no AWS call**. With it, the command asks a Bedrock model once for
the Japanese form and the katakana reading of the top `--max-terms` proposed terms. It uses the AWS CLI
(`aws bedrock-runtime converse`, or `invoke-model` on an older CLI), so you need AWS credentials that may invoke the
model.

- Model: `--model`, else `LLM_MODEL_ID`, else `llmModelId` from `cdk/cdk.json` (a `jp.` profile). Region: `--region`,
  else `AWS_REGION`, else `ap-northeast-1`.
- Every suggestion is marked `UNVERIFIED (bedrock <model>)` in `notes`. The flags stay as they were, so nothing is
  generated from a suggestion until you read it, correct it and set the flags. Have a native speaker check the
  readings.
- `en` is never changed. A suggestion whose `en` does not match an input is dropped. A term with a capital letter or a
  digit keeps its English spelling in `ja`. A reading that breaks the Polly character rules is dropped.
- **Cost.** The command prints an estimate before it calls and the real usage after. A test run with 10 terms used 219
  input and 369 output tokens, about $0.002 at the Haiku in-country price in `scripts/cost-prices.json`. 50 terms is
  roughly 1,000 to 1,500 input and about 2,000 output tokens, around one cent. For a model that is not Haiku the
  command shows the token counts and says the price is unknown. There is no other charge.

## Keeping your dictionary elsewhere

A dictionary of customer or event terms may be private. Keep it in its own private repository and point the stack at it:

```json
{ "dictionaries": { "dir": "../my-dictionaries" } }
```

or `-c dictionaryDir=/path/to/my-dictionaries`, or `DICTIONARY_DIR=/path/to/my-dictionaries` for the scripts. A
relative path is relative to the repository root; an absolute path is safer. The folder needs `terms.csv` and the three
generated files (run `generate --dir <folder>`).

**A gitignored folder has no history.** `dictionaries/local/` is excluded from git so it cannot be committed by
mistake. That also means git cannot restore it. Back it up, or make it its own private git repository (`git init`
inside it, or keep it in a separate clone and use `dictionaryDir`). `scripts/check-publishable.mjs` fails if a file
under `dictionaries/local/` is tracked or ever was.

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
- **Check every alias by ear.** Polly can insert a pause where you do not expect one. In the example dictionary the
  readings for `ST 2110` and `ST 2022-7` use a katakana long-sound spelling because the hiragana spelling made Polly pause
  after "に". A native speaker should review every reading.
- **Acronyms can need a rule per spelling.** `SCTE-35`, `SCTE 35` and `SCTE-104` each need a row, because the longest
  matching term wins.
- **Terminology is case-insensitive**, so each English term appears once.

## Rules for each file

`node dictionaries/build.mjs generate` runs `node dictionaries/validate.mjs` on its output, so the generated files
already pass. You can also run `node dictionaries/validate.mjs [dir]` yourself. It checks the three files against the
Transcribe and Translate format rules and prints line-numbered errors. Details of each format are in
[`dictionaries/example/README.md`](../dictionaries/example/README.md).

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
node dictionaries/build.mjs generate
cd cdk
./scripts/dictionaries.sh --dry-run          # prints the folder, the S3 key, sizes and sha256; no AWS call
./scripts/dictionaries.sh --restart-app
```

The script (needs AWS credentials for the same account and Region as the stack):

1. creates a private S3 bucket `simul-translation-dict-<account>-<region>` if it does not exist,
2. uploads the vocabulary, then creates or updates the Transcribe vocabulary `simul-translation` and waits for `READY`,
3. imports the Translate terminology `simul-translation` (overwrite),
4. with `--restart-app`, restarts the Fargate task so it loads the new dictionaries.

The script prints which folder it uses. Env variables: `AWS_REGION` (default `ap-northeast-1`), `DICT_NAME` (default
`simul-translation`), `DICTIONARY_DIR` (or `--dir`; the older name `DICT_DIR` still works), `STACK_NAME`. If you change `DICT_NAME`, set the same names in
`event.json` (`dictionaries.transcribeVocabulary` and `dictionaries.translateTerminology`) and deploy.

Polly readings and context corrections ship in the app image. After editing them, run `npx cdk deploy` from `cdk/`.
The stack copies `polly-readings.csv` from the dictionary folder into the image at build time, and the file's content
is part of the image hash, so a changed reading always builds a new image. For a local run without Docker, set
`POLLY_READINGS_FILE` to the file.
