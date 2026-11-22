#!/usr/bin/env bash
# Create or update the Transcribe custom vocabulary and the Translate custom terminology
# from the generated dictionary files. Run BEFORE the event (and after every dictionary edit).
#
#   ./scripts/dictionaries.sh                # create/update both
#   ./scripts/dictionaries.sh --restart-app  # ...then restart the Fargate task to pick them up
#   ./scripts/dictionaries.sh --dry-run      # print what would be sent (S3 key, sizes, sha256) and the plan; no AWS call
#   ./scripts/dictionaries.sh --dir <dir>    # use this dictionary folder
#   ./scripts/dictionaries.sh --yes          # do not ask before deleting an old uni-directional terminology (see below)
#
# Dictionary folder, first match wins: --dir, env DICTIONARY_DIR (or the older DICT_DIR),
# dictionaryDir from cdk/config/event.json (dictionaries.dir), dictionaries/local/ if it exists,
# else dictionaries/example/. Generate the files first: node dictionaries/build.mjs generate.
#
# The Translate terminology is ONE multi-directional terminology ($DICT_NAME, Directionality=MULTI, header en,ja). Both
# channels use it: en to ja as written, ja to en in reverse. The Amazon Translate documentation does not say that an
# OVERWRITE import can change a terminology from uni- to multi-directional. So before importing, the script reads the
# directionality of $DICT_NAME (get-terminology): missing -> import; MULTI -> import (OVERWRITE); UNI (or unset, which
# behaves as UNI) -> it explains the impact, asks [y/N] (or takes --yes; without a terminal and without --yes it stops),
# deletes the terminology and imports it again as MULTI. Between delete and import the lanes run without the glossary.
#
# Two-channel mode (docs/bilingual-channels.md): when the folder also has transcribe-vocabulary-ja.txt (generated from the
# rows that have a reading), it is uploaded too, as the Transcribe vocabulary $DICT_NAME_JA (ja-JP). Without that file
# nothing changes.
#
# Env: AWS_REGION (default ap-northeast-1), DICT_NAME (default simul-translation),
#      DICT_NAME_JA (default $DICT_NAME-ja),
#      DICTIONARY_DIR (see above), STACK_NAME (default SimulTranslation; used by --restart-app).
set -euo pipefail
REGION="${AWS_REGION:-ap-northeast-1}"
DICT_NAME="${DICT_NAME:-simul-translation}"
DICT_NAME_JA="${DICT_NAME_JA:-$DICT_NAME-ja}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/.."
REPO_ROOT="$SCRIPT_DIR/../.."
STACK_NAME="${STACK_NAME:-SimulTranslation}"
RESTART_APP=false
DRY_RUN=false
ASSUME_YES=false
DIR_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-app) RESTART_APP=true ;;
    --dry-run) DRY_RUN=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --dir) DIR_ARG="${2:?--dir needs a folder}"; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
# Resolve the dictionary folder: prints "<dir><TAB><source>".
resolve_dir() {
  local setting="${DIR_ARG:-${DICTIONARY_DIR:-${DICT_DIR:-}}}"
  if [[ -z "$setting" && -f "$CDK_DIR/config/event.json" && -d "$CDK_DIR/node_modules" ]]; then
    # event.json may set dictionaries.dir; resolved-config applies the same layers as cdk synth.
    local cfg
    if cfg="$(cd "$CDK_DIR" && npx --no-install ts-node scripts/resolved-config.ts 2>/dev/null)"; then
      node -e 'const c=JSON.parse(process.argv[1]); if(!c.ok||!c.dictionaryDir) process.exit(1); console.log(c.dictionaryDir+"\t"+c.dictionaryDirSource)' "$cfg" 2>/dev/null && return 0
    fi
  fi
  if [[ -n "$setting" ]]; then
    node "$REPO_ROOT/dictionaries/build.mjs" where --dir "$setting"
  else
    node "$REPO_ROOT/dictionaries/build.mjs" where
  fi
}
RESOLVED="$(resolve_dir)" || { echo "cannot resolve the dictionary folder" >&2; exit 1; }
DICT_DIR="${RESOLVED%%$'\t'*}"
DICT_SOURCE="${RESOLVED##*$'\t'}"
echo "Using dictionaries: $DICT_DIR ($DICT_SOURCE)"
if [[ "$DICT_SOURCE" == "example" ]]; then
  echo "Note: this is the example dictionary (AWS Elemental Media Services). Build your own: node dictionaries/build.mjs init"
fi
VOCAB_FILE="$DICT_DIR/transcribe-vocabulary.txt"
TERM_FILE="$DICT_DIR/translate-terminology.csv"
[[ -f "$VOCAB_FILE" ]] || { echo "missing $VOCAB_FILE (run: node dictionaries/build.mjs generate --dir $DICT_DIR)" >&2; exit 1; }
[[ -f "$TERM_FILE" ]] || { echo "missing $TERM_FILE (run: node dictionaries/build.mjs generate --dir $DICT_DIR)" >&2; exit 1; }
VOCAB_JA_FILE="$DICT_DIR/transcribe-vocabulary-ja.txt"
if $DRY_RUN; then
  fileinfo() { # sha256, bytes, data rows (header excluded)
    node -e 'const fs=require("fs"),c=require("crypto");const b=fs.readFileSync(process.argv[1]);console.log(c.createHash("sha256").update(b).digest("hex")+"  "+b.length+" bytes  "+(b.toString("utf8").split("\n").length-2)+" entries")' "$1"
  }
  echo "DRY RUN: no AWS call is made."
  echo "Region: $REGION   Name: $DICT_NAME"
  echo "S3 upload: s3://simul-translation-dict-<account>-$REGION/vocab/transcribe-vocabulary.txt"
  echo "Transcribe: create-vocabulary or update-vocabulary --vocabulary-name $DICT_NAME --language-code en-US --vocabulary-file-uri <that S3 URI>"
  echo "Translate:  import-terminology --name $DICT_NAME --merge-strategy OVERWRITE --terminology-data Format=CSV,Directionality=MULTI --data-file $TERM_FILE"
  echo "Translate:  before the import, get-terminology --name $DICT_NAME reads the directionality: missing or MULTI -> import; UNI -> ask, delete-terminology, import again as MULTI (the lanes have no glossary in between; --yes skips the question)"
  echo "transcribe-vocabulary.txt  $(fileinfo "$VOCAB_FILE")"
  echo "translate-terminology.csv  $(fileinfo "$TERM_FILE")"
  if [[ -f "$VOCAB_JA_FILE" ]]; then
    echo "S3 upload: s3://simul-translation-dict-<account>-$REGION/vocab/transcribe-vocabulary-ja.txt"
    echo "Transcribe: create-vocabulary or update-vocabulary --vocabulary-name $DICT_NAME_JA --language-code ja-JP --vocabulary-file-uri <that S3 URI>"
    echo "transcribe-vocabulary-ja.txt  $(fileinfo "$VOCAB_JA_FILE")"
  fi
  exit 0
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="simul-translation-dict-$ACCOUNT-$REGION"

# Private bucket for the vocabulary table (Transcribe table format requires an S3 URI).
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "Creating private bucket $BUCKET"
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Uploads a vocabulary table, creates or updates the Transcribe vocabulary and waits for READY.
sync_vocabulary() { # name language-code file s3-key
  local name="$1" lang="$2" file="$3" key="$4"
  local uri="s3://$BUCKET/vocab/$key"
  aws s3 cp "$file" "$uri" --region "$REGION"
  if aws transcribe get-vocabulary --vocabulary-name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo "Updating Transcribe vocabulary $name"
    aws transcribe update-vocabulary --vocabulary-name "$name" --language-code "$lang" \
      --vocabulary-file-uri "$uri" --region "$REGION" >/dev/null
  else
    echo "Creating Transcribe vocabulary $name"
    aws transcribe create-vocabulary --vocabulary-name "$name" --language-code "$lang" \
      --vocabulary-file-uri "$uri" --region "$REGION" >/dev/null
  fi
  echo -n "Waiting for vocabulary to become READY"
  local state=""
  for _ in $(seq 1 90); do
    state="$(aws transcribe get-vocabulary --vocabulary-name "$name" --region "$REGION" \
      --query VocabularyState --output text)"
    if [[ "$state" == "READY" ]]; then echo " READY"; break; fi
    if [[ "$state" == "FAILED" ]]; then
      echo " FAILED" >&2
      aws transcribe get-vocabulary --vocabulary-name "$name" --region "$REGION" \
        --query FailureReason --output text >&2
      exit 1
    fi
    echo -n "."
    sleep 10
  done
  [[ "$state" == "READY" ]] || { echo " timed out (state=$state)" >&2; exit 1; }
}
sync_vocabulary "$DICT_NAME" en-US "$VOCAB_FILE" transcribe-vocabulary.txt
if [[ -f "$VOCAB_JA_FILE" ]]; then
  sync_vocabulary "$DICT_NAME_JA" ja-JP "$VOCAB_JA_FILE" transcribe-vocabulary-ja.txt
fi
# One multi-directional terminology for both channels. See the header for why the directionality is read first.
import_terminology() {
  echo "Importing Translate terminology $DICT_NAME (multi-directional)"
  aws translate import-terminology --name "$DICT_NAME" --merge-strategy OVERWRITE \
    --terminology-data Format=CSV,Directionality=MULTI --data-file "fileb://$TERM_FILE" --region "$REGION" >/dev/null
}
TERM_ERR="$(mktemp)"
trap 'rm -f "$TERM_ERR"' EXIT
if DIRECTIONALITY="$(aws translate get-terminology --name "$DICT_NAME" --terminology-data-format CSV \
    --query TerminologyProperties.Directionality --output text --region "$REGION" 2>"$TERM_ERR")"; then
  if [[ "$DIRECTIONALITY" == "MULTI" ]]; then
    import_terminology
  else
    echo "The Translate terminology $DICT_NAME exists and is uni-directional (directionality: ${DIRECTIONALITY:-unset})."
    echo "The documentation does not say that an OVERWRITE import turns it into a multi-directional one, so the script"
    echo "deletes it and imports it again as MULTI. Until the import finishes (seconds) the lanes translate without"
    echo "the glossary; running tasks use the new terminology once it has propagated (up to about 10 minutes)."
    if ! $ASSUME_YES; then
      if [[ -t 0 ]]; then
        read -r -p "Delete $DICT_NAME and import it again as multi-directional? [y/N] " ANSWER
        [[ "$ANSWER" =~ ^[Yy]([Ee][Ss])?$ ]] || { echo "Not changed."; exit 1; }
      else
        echo "No terminal to ask: nothing was changed. Run again with --yes to delete and re-create it." >&2
        exit 1
      fi
    fi
    echo "Deleting Translate terminology $DICT_NAME"
    aws translate delete-terminology --name "$DICT_NAME" --region "$REGION" >/dev/null
    import_terminology
  fi
elif grep -q "ResourceNotFoundException" "$TERM_ERR"; then
  import_terminology
else
  echo "cannot read the Translate terminology $DICT_NAME:" >&2
  cat "$TERM_ERR" >&2
  exit 1
fi
echo "Done: TRANSCRIBE_VOCABULARY=$DICT_NAME TRANSLATE_TERMINOLOGY=$DICT_NAME (region $REGION)"
if [[ -f "$VOCAB_JA_FILE" ]]; then
  echo "Two-channel mode: the ja-JP channel uses the same terminology by default; transcribeVocabulary=$DICT_NAME_JA is optional (set it on the ja-JP channel in event.json)"
fi

if $RESTART_APP; then
  output() {
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
  }
  CLUSTER="$(output EcsClusterName)"
  SERVICE="$(output EcsServiceName)"
  echo "Restarting ECS service $SERVICE in $CLUSTER"
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment \
    --region "$REGION" >/dev/null
fi
