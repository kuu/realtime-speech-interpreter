# Samples: test audio you can reproduce

Scripted English (and some Japanese) speech for trying the system and the E2E harness without recordings of your own.
The audio is generated with Amazon Polly from the text files in `samples/scripts/`. The text is generic and fictional
(an invented streaming product called "Lumenstream"); it contains no real company material.

| Sample | What it is | Length | Use it to |
|---|---|---|---|
| `talk-single` | One English speaker, 8 paragraphs with technical terms (SRT, HLS, CDN, SDK, Kubernetes, p99 latency) | about 2 min | Try the current single-speaker flow; test your dictionary |
| `dialogue-two-speakers` | Two English speakers (Joanna and Matthew) alternating, 13 turns | about 1.5 min | Prepare for speaker detection and per-speaker voices |
| `qa-bilingual` | English answers with 4 Japanese audience questions (Takumi, Kazuha, Tomoko) | about 1.2 min | Test the Japanese-speech filter; prepare for the two-channel mode |
| `monologue-ja` | One Japanese speaker (Takumi), a fictional product talk, no English | about 3 min | Pure Japanese source: measure channel 2 alone (`e2e.sh run ... --japanese-only`); the recording is made by the owner |

Each sample has `scripts/<name>.txt` (the exact spoken script, which is the ground truth) and `scripts/<name>.notes.md` (what
a good translation looks like).

## Generate the audio

Needs the AWS CLI v2 with credentials that allow `polly:SynthesizeSpeech`, and ffmpeg.

```
./samples/make-samples.sh                 # all three
./samples/make-samples.sh talk-single     # one
```

This writes `samples/out/<name>.wav` (16 kHz mono) and `samples/out/<name>.timeline.tsv` (start and end second, voice and text of every turn).
The region defaults to `ap-northeast-1` (`SAMPLES_REGION` overrides). Cost: Polly neural voices, about USD 16 per
million characters; all three scripts are about 5,000 characters, so a full run costs under 10 cents.
The output is the same on every run, up to Polly voice updates.

**The generated audio is not committed** (`samples/out/` is gitignored). The terms of Polly output have not been verified
for redistribution in this project, so the repository ships only the scripts and you generate the audio yourself.
Do not add generated audio to a pull request.

## Run a sample through the system

Offline (no deployed stack needed; uses Transcribe, Translate or Bedrock, and Polly on your account, an estimated 4 cents per minute of audio):

```
./e2e/e2e.sh local --file samples/out/talk-single.wav --duration 1m --label sample-talk
```

`--file` accepts a path to any audio or video file ffmpeg can read (WAV, MP3, M4A, MP4, and so on); the numbers `1`-`4` stay
reserved for your own recordings named `NN_*.m4a` in the folder given by `E2E_RECORDINGS`.
Run output goes to `e2e/runs/` (gitignored). With a deployed stack, `./e2e/e2e.sh run --file samples/out/talk-single.wav`
streams the sample over SRT like OBS would. See `e2e/README.md`.

To listen to a sample first: `afplay samples/out/talk-single.wav` (macOS).

## Public sources for real-world audio

Use real recordings to test accents, noise and spontaneous speech. Check the license of each item before you use or share it; the
licenses below were checked against the publishers' pages on the date in the last column, and they can change.

| Source | License | Notes |
|---|---|---|
| [LibriVox](https://librivox.org/pages/public-domain/) audiobooks | Public domain in the USA (LibriVox states that anyone may use the recordings however they wish) | Read books, single speaker, clean audio. Not spontaneous speech. Outside the USA, check the status of the underlying book. |
| [Wikimedia Commons audio](https://commons.wikimedia.org/wiki/Commons:Audio) | Free licenses only, but different per file (CC BY, CC BY-SA, CC0, public domain) | Read the license on each file page and keep the attribution. CC BY-SA requires sharing alike. |
| [NASA media](https://www.nasa.gov/nasa-brand-center/images-and-media/) (US government works) | NASA states its audio and video are generally not subject to copyright in the USA | Real multi-speaker briefings. Exceptions: items marked as third-party copyright, and the NASA logos. Acknowledge NASA as the source and do not imply endorsement. |
| [Mozilla Common Voice](https://commonvoice.mozilla.org/en/datasets) ([terms](https://commonvoice.mozilla.org/terms/en.html)) | CC0 | Short read sentences from many speakers and accents, in many languages including Japanese. |
| [CSTR VCTK Corpus](https://datashare.ed.ac.uk/handle/10283/3443) | CC BY 4.0 (as stated by the dataset page and widely reported; confirm on the page) | Read English by about 110 speakers with various accents. Attribute the authors. |

Licenses checked against the publishers' pages on 2026-11-15; they can change, and the Commons and NASA items need a check per file.

Not suitable for redistribution: TED talks and most conference videos use CC BY-NC-ND (no commercial use, no derivatives).
You may watch them to test privately, but do not put the audio, a clip or a translation of it into this repository or any
public project. The same applies to YouTube videos without an explicit open license.

None of these files is included in this repository.
