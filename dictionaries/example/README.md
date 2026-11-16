# Example dictionaries (AWS Elemental Media Services)

These are generated from `terms.csv` in this folder by `node dictionaries/build.mjs generate --dir dictionaries/example`. Do not edit the three generated files by hand; edit `terms.csv` and regenerate. Format and workflow: [docs/dictionaries.md](../../docs/dictionaries.md).

Domain dictionaries for accurate handling of technical terms. Prepared and uploaded
before the event; versioned here.

## How these were generated

Terms were collected from the public AWS Elemental Media Services user guides
(MediaConnect, MediaLive, MediaConvert, MediaPackage, MediaTailor, Elemental Inference),
English and ja_jp pages, read-only. Japanese wording follows the ja_jp docs where they
exist; where the ja docs are missing or inconsistent, one form was picked. No page content is
copied into this repo.

Selection rules:
- Vocabulary: only terms en-US ASR is likely to mis-hear (product names, acronyms,
  codecs/protocols, jargon). Kept focused (~250 rows); large lists hurt accuracy.
- Terminology: AWS service/product names stay in English exactly as the ja docs write them;
  industry acronyms (HLS, DASH, CMAF, SRT, SCTE-35, ...) stay as-is; AWS media concepts use
  the ja docs' wording (channel = チャンネル, origin endpoint = オリジンエンドポイント, ...).
  Generic words whose forced translation would hurt other sentences are left out
  (e.g. `ads`/`ADS`, `VAST`, `slate`, `feed`, `job`).
- The terminology `en` spelling matches the vocabulary `DisplayAs` output.


## Validate before uploading

```
node dictionaries/validate.mjs dictionaries/example
```
Checks both files against the Transcribe/Translate format rules (header, column count,
TAB separation, en-US character set, acronym periods, no digits/spaces in Phrase, empty
SoundsLike/IPA, size limits, duplicates, CSV parsing/quoting, BOM). Exits non-zero with
line-numbered messages on failure. A bad vocabulary row makes `dictionaries.sh` stop before
the terminology import, so run this first.

## Transcribe custom vocabulary (English recognition)

`transcribe-vocabulary.txt` — TAB-delimited table with the four documented columns
`Phrase / SoundsLike / IPA / DisplayAs`. SoundsLike and IPA are left empty (Transcribe no
longer uses them). Phrase uses hyphens between words, `A.B.C.` for spelled-out acronyms,
and spelled-out numbers; DisplayAs holds the output form (digits allowed, e.g. `SCTE-35`).
Biases speech recognition toward domain terms (e.g. "verticalization", which is otherwise
mis-heard as "fertilization").

Upload and create (normally via `cdk/scripts/dictionaries.sh`):
```
aws s3 cp transcribe-vocabulary.txt s3://<bucket>/vocab/transcribe-vocabulary.txt --region ap-northeast-1
aws transcribe create-vocabulary \
  --vocabulary-name simul-translation \
  --language-code en-US \
  --vocabulary-file-uri s3://<bucket>/vocab/transcribe-vocabulary.txt \
  --region ap-northeast-1
```
Then set `TRANSCRIBE_VOCABULARY=simul-translation`.

Note: custom vocabulary biases but does not guarantee every instance. The app also
applies a post-recognition correction map (`app/src/corrections.ts`) for confusions
where the wrong word is itself valid English.

## Translate custom terminology (English → Japanese glossary)

`translate-terminology.csv` — `en,ja` glossary (UTF-8, no BOM, no quoted fields) for
consistent term translation. Matching is case-insensitive, so each `en` term appears once.

Create (normally via `cdk/scripts/dictionaries.sh`):
```
aws translate import-terminology \
  --name simul-translation \
  --merge-strategy OVERWRITE \
  --terminology-data File=fileb://translate-terminology.csv,Format=CSV \
  --region ap-northeast-1
```
Then set `TRANSLATE_TERMINOLOGY=simul-translation`. An overwrite can take up to 10 minutes
to propagate.

## Polly pronunciation readings
`polly-readings.csv` (`term,reading`, `#` comments) ships in the app Docker image at `/app/assets/polly-readings.csv`
(the stack copies it from the resolved dictionary folder at build time). It is not uploaded to AWS. `validate.mjs`
checks it too (duplicates, empty fields, allowed reading characters, no `"<>&`, longest-match consistency warnings).
To change a reading: edit `terms.csv`, run `node dictionaries/build.mjs generate`, redeploy the app.
The product name is never altered in text: the term stays unchanged as the `<sub>` element text and in every log, context and validator; only the alias changes how Polly pronounces it.
