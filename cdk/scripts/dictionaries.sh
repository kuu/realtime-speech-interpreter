#!/usr/bin/env bash
# Create or update the Transcribe custom vocabulary and the Translate custom terminology
# from dictionaries. Run BEFORE the event (and after every dictionary edit).
#
#   ./scripts/dictionaries.sh                # create/update both
#   ./scripts/dictionaries.sh --restart-app  # ...then restart the Fargate task to pick them up
#
# Env: AWS_REGION (default ap-northeast-1), DICT_NAME (default simul-translation),
#      DICT_DIR (default ../../dictionaries relative to this script),
#      STACK_NAME (default SimulTranslation; used by --restart-app).
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
DICT_NAME="${DICT_NAME:-simul-translation}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DICT_DIR="${DICT_DIR:-$SCRIPT_DIR/../../dictionaries}"
STACK_NAME="${STACK_NAME:-SimulTranslation}"
RESTART_APP=false
[[ "${1:-}" == "--restart-app" ]] && RESTART_APP=true

VOCAB_FILE="$DICT_DIR/transcribe-vocabulary.txt"
TERM_FILE="$DICT_DIR/translate-terminology.csv"
[[ -f "$VOCAB_FILE" ]] || { echo "missing $VOCAB_FILE" >&2; exit 1; }
[[ -f "$TERM_FILE" ]] || { echo "missing $TERM_FILE" >&2; exit 1; }

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
