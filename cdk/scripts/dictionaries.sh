#!/usr/bin/env bash
# Create or update the Transcribe custom vocabulary and the Translate custom terminology
# from the generated dictionary files. Run BEFORE the event (and after every dictionary edit).
#
#   ./scripts/dictionaries.sh                # create/update both
#   ./scripts/dictionaries.sh --restart-app  # ...then restart the Fargate task to pick them up
#   ./scripts/dictionaries.sh --dry-run      # print what would be sent (S3 key, sizes, sha256); no AWS call
#   ./scripts/dictionaries.sh --dir <dir>    # use this dictionary folder
#
# Dictionary folder, first match wins: --dir, env DICTIONARY_DIR (or the older DICT_DIR),
# dictionaryDir from cdk/config/event.json (dictionaries.dir), dictionaries/local/ if it exists,
# else dictionaries/example/. Generate the files first: node dictionaries/build.mjs generate.
#
# Env: AWS_REGION (default ap-northeast-1), DICT_NAME (default simul-translation),
#      DICTIONARY_DIR (see above), STACK_NAME (default SimulTranslation; used by --restart-app).
set -euo pipefail
REGION="${AWS_REGION:-ap-northeast-1}"
DICT_NAME="${DICT_NAME:-simul-translation}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/.."
REPO_ROOT="$SCRIPT_DIR/../.."
STACK_NAME="${STACK_NAME:-SimulTranslation}"
RESTART_APP=false
DRY_RUN=false
DIR_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-app) RESTART_APP=true ;;
    --dry-run) DRY_RUN=true ;;
    --dir) DIR_ARG="${2:?--dir needs a folder}"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
if $DRY_RUN; then
  fileinfo() { # sha256, bytes, data rows (header excluded)
    node -e 'const fs=require("fs"),c=require("crypto");const b=fs.readFileSync(process.argv[1]);console.log(c.createHash("sha256").update(b).digest("hex")+"  "+b.length+" bytes  "+(b.toString("utf8").split("\n").length-2)+" entries")' "$1"
  }
  echo "DRY RUN: no AWS call is made."
  echo "Region: $REGION   Name: $DICT_NAME"
  echo "S3 upload: s3://simul-translation-dict-<account>-$REGION/vocab/transcribe-vocabulary.txt"
  echo "Transcribe: create-vocabulary or update-vocabulary --vocabulary-name $DICT_NAME --language-code en-US --vocabulary-file-uri <that S3 URI>"
  echo "Translate:  import-terminology --name $DICT_NAME --merge-strategy OVERWRITE --terminology-data Format=CSV --data-file $TERM_FILE"
  echo "transcribe-vocabulary.txt  $(fileinfo "$VOCAB_FILE")"
  echo "translate-terminology.csv  $(fileinfo "$TERM_FILE")"
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

VOCAB_URI="s3://$BUCKET/vocab/transcribe-vocabulary.txt"
aws s3 cp "$VOCAB_FILE" "$VOCAB_URI" --region "$REGION"

if aws transcribe get-vocabulary --vocabulary-name "$DICT_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating Transcribe vocabulary $DICT_NAME"
  aws transcribe update-vocabulary --vocabulary-name "$DICT_NAME" --language-code en-US \
    --vocabulary-file-uri "$VOCAB_URI" --region "$REGION" >/dev/null
else
  echo "Creating Transcribe vocabulary $DICT_NAME"
  aws transcribe create-vocabulary --vocabulary-name "$DICT_NAME" --language-code en-US \
    --vocabulary-file-uri "$VOCAB_URI" --region "$REGION" >/dev/null
fi

echo -n "Waiting for vocabulary to become READY"
for _ in $(seq 1 90); do
  STATE="$(aws transcribe get-vocabulary --vocabulary-name "$DICT_NAME" --region "$REGION" \
    --query VocabularyState --output text)"
  if [[ "$STATE" == "READY" ]]; then echo " READY"; break; fi
  if [[ "$STATE" == "FAILED" ]]; then
    echo " FAILED" >&2
    aws transcribe get-vocabulary --vocabulary-name "$DICT_NAME" --region "$REGION" \
      --query FailureReason --output text >&2
    exit 1
  fi
  echo -n "."
  sleep 10
done
[[ "${STATE:-}" == "READY" ]] || { echo " timed out (state=$STATE)" >&2; exit 1; }

echo "Importing Translate terminology $DICT_NAME"
aws translate import-terminology --name "$DICT_NAME" --merge-strategy OVERWRITE \
  --terminology-data Format=CSV --data-file "fileb://$TERM_FILE" --region "$REGION" >/dev/null

echo "Done: TRANSCRIBE_VOCABULARY=$DICT_NAME TRANSLATE_TERMINOLOGY=$DICT_NAME (region $REGION)"

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
