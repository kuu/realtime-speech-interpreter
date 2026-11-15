#!/usr/bin/env bash
# Preflight check before `cdk deploy` or a rehearsal. Read-only: it never changes AWS or your files.
#
#   ./scripts/doctor.sh [-c key=value ...] [--skip-aws]
#
# Takes the same -c flags as `cdk` and reads cdk/config/event.json like `cdk synth` does.
# Prints PASS / WARN / FAIL with the exact fix command. Exit code 1 if any FAIL.
# --skip-aws  run only the local checks (no AWS calls).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$SCRIPT_DIR/../cdk"
SKIP_AWS=false
CARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--context) CARGS+=("-c" "${2:-}"); shift 2 ;;
    --skip-aws) SKIP_AWS=true; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

NFAIL=0; NWARN=0; NPASS=0
pass() { NPASS=$((NPASS + 1)); printf 'PASS  %s\n' "$1"; }
warn() { NWARN=$((NWARN + 1)); printf 'WARN  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '      fix: %s\n' "$2"; return 0; }
fail() { NFAIL=$((NFAIL + 1)); printf 'FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '      fix: %s\n' "$2"; return 0; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(Array.isArray(v)?v.join(" "):v==null?"":String(v))}catch(e){}})' "$1"; }

echo "== Local tools"
# Node / npm
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v | sed 's/^v//')"
  if [[ "${NODE_V%%.*}" -ge 20 ]]; then pass "Node $NODE_V (>= 20)"; else
    fail "Node $NODE_V is older than 20" "install Node 22 LTS (for example: nvm install 22 && nvm use 22)"; fi
else
  fail "Node is not installed" "install Node 22 LTS from https://nodejs.org/ or with nvm"
fi
if command -v npm >/dev/null 2>&1; then
  NPM_V="$(npm -v)"
  if [[ "${NPM_V%%.*}" -ge 9 ]]; then pass "npm $NPM_V (>= 9)"; else
    fail "npm $NPM_V is older than 9" "npm install -g npm@latest"; fi
else
  fail "npm is not installed" "it ships with Node: reinstall Node 22 LTS"
fi
if [[ -d "$CDK_DIR/node_modules" ]]; then pass "cdk/node_modules present"; else
  fail "cdk/node_modules missing" "cd cdk && npm ci"; fi

# Docker
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then pass "Docker daemon is running"; else
    fail "Docker is installed but the daemon is not running (cdk deploy builds the app image)" "start Docker Desktop (or: sudo systemctl start docker)"; fi
else
  fail "Docker is not installed (cdk deploy builds the app image)" "install Docker Desktop or Docker Engine"
fi

# ffmpeg (only the local tests and e2e use it; the Fargate image brings its own)
if command -v ffmpeg >/dev/null 2>&1; then
  if ffmpeg -hide_banner -protocols 2>/dev/null | grep -Eq '^ *srt$'; then SRT_OK=true; else SRT_OK=false; fi
  if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libopus; then OPUS_OK=true; else OPUS_OK=false; fi
  if $SRT_OK && $OPUS_OK; then pass "ffmpeg has libsrt and libopus"; else
    warn "ffmpeg lacks $($SRT_OK || echo -n 'libsrt ')$($OPUS_OK || echo -n 'libopus') (needed only for local tests and ./e2e/e2e.sh)" "macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg (check 'ffmpeg -protocols | grep srt')"; fi
else
  warn "ffmpeg not found (needed only for local tests and ./e2e/e2e.sh)" "macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg"
fi

echo "== Resolved configuration"
RC=""
if [[ -d "$CDK_DIR/node_modules" ]] && command -v node >/dev/null 2>&1; then
  RC="$(cd "$CDK_DIR" && node_modules/.bin/ts-node scripts/resolved-config.ts ${CARGS[@]+"${CARGS[@]}"} 2>/dev/null | tail -1)"
fi
REGION="" ENGINE="" MODEL="" VOCAB="" TERM="" CIDRS=""
if [[ -z "$RC" ]]; then
  fail "could not read the configuration (see the missing tools above)" "cd cdk && npm ci"
else
  if [[ "$(printf '%s' "$RC" | jget ok)" == "true" ]]; then
    REGION="$(printf '%s' "$RC" | jget region)"
    ENGINE="$(printf '%s' "$RC" | jget translateEngine)"
    MODEL="$(printf '%s' "$RC" | jget llmModelId)"
    VOCAB="$(printf '%s' "$RC" | jget transcribeVocabularyName)"
    TERM="$(printf '%s' "$RC" | jget translateTerminologyName)"
    CIDRS="$(printf '%s' "$RC" | jget venueCidrs)"
    EVF="$(printf '%s' "$RC" | jget eventFile)"
    pass "configuration is valid (profile $(printf '%s' "$RC" | jget profile), region $REGION, engine $ENGINE, event file: ${EVF:-none})"
  else
    ERR="$(printf '%s' "$RC" | jget error)"
    REGION="$(printf '%s' "$RC" | jget region)"
    if [[ "$ERR" == *venueCidr* ]]; then
      fail "venueCidr is missing or invalid: $ERR" "set \"venueCidr\" in cdk/config/event.json (copy event.example.json) or pass -c venueCidr=<your venue egress IP>/32"
    else
      fail "configuration error: $ERR" "fix the value named in the message (cdk/config/event.json or your -c flags); see docs/configuration.md"
    fi
  fi
fi

if [[ -n "$CIDRS" ]]; then
  for c in $CIDRS; do
    ip="${c%/*}"; prefix="${c#*/}"
    if [[ "$c" == "0.0.0.0/0" ]]; then
      fail "venueCidr $c opens the SRT port to the world" "use the venue's public egress IP: curl https://checkip.amazonaws.com (from the venue network)"
    elif [[ "$ip" == 203.0.113.* || "$ip" == 198.51.100.* || "$ip" == 192.0.2.* ]]; then
      warn "venueCidr $c is a documentation address (the example file value); OBS from the venue will be refused" "put the venue's real public IP in cdk/config/event.json (curl https://checkip.amazonaws.com from the venue network)"
    elif [[ "$ip" == 10.* || "$ip" == 192.168.* || "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]; then
      warn "venueCidr $c is a private address; AWS sees your public egress IP instead" "use the public IP: curl https://checkip.amazonaws.com"
    elif [[ "$prefix" -lt 24 ]]; then
      warn "venueCidr $c is wide (/$prefix); every address in it may send SRT" "use /32 unless the venue egress pool is known"
    else
      pass "venueCidr $c"
    fi
  done
fi

echo "== AWS"
if $SKIP_AWS; then
  warn "AWS checks skipped (--skip-aws)"
else
  REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}}"
  AWS_OK=false
  if command -v aws >/dev/null 2>&1; then
    AWS_V="$(aws --version 2>&1 | awk '{print $1}')"
    if [[ "$AWS_V" == aws-cli/2.* ]]; then pass "AWS CLI $AWS_V"; AWS_OK=true; else
      fail "AWS CLI v2 required, found $AWS_V" "install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"; fi
  else
    fail "AWS CLI is not installed" "install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
  if $AWS_OK; then
    ID="$(aws sts get-caller-identity --region "$REGION" --output json 2>/dev/null)"
    if [[ -z "$ID" ]]; then
      fail "no usable AWS credentials" "aws configure (or aws sso login --profile <name>, then export AWS_PROFILE=<name>)"
    else
      ACCOUNT="$(printf '%s' "$ID" | jget Account)"
      ARN="$(printf '%s' "$ID" | jget Arn)"
      pass "AWS identity: account $ACCOUNT, ${ARN##*:}, region $REGION"
      # CDK bootstrap
      BS="$(aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"
      if [[ "$BS" == CREATE_COMPLETE || "$BS" == UPDATE_COMPLETE ]]; then pass "CDK is bootstrapped in $REGION ($BS)"; else
        fail "CDK is not bootstrapped in $REGION (${BS:-no CDKToolkit stack})" "cd cdk && npx cdk bootstrap aws://$ACCOUNT/$REGION"; fi
      # Bedrock (LLM engine only)
      if [[ "$ENGINE" == "llm" ]]; then
        FOUND=""
        OUT="$(aws bedrock list-inference-profiles --region "$REGION" --type-equals SYSTEM_DEFINED --query "inferenceProfileSummaries[?inferenceProfileId=='$MODEL'].status" --output text 2>&1)"
        if [[ "$OUT" == *"Invalid choice"* || "$OUT" == *"Unknown options"* ]]; then
          BASE="${MODEL#*.}"; BASE="${BASE%%:*}"
          FM="$(aws bedrock list-foundation-models --region "$REGION" --query "modelSummaries[?starts_with(modelId,'$BASE')].modelId" --output text 2>/dev/null)"
          if [[ -n "$FM" ]]; then
            warn "AWS CLI $AWS_V cannot list inference profiles; the base model ${FM%%[[:space:]]*} is offered in $REGION but profile $MODEL was not checked" "upgrade AWS CLI v2, then rerun"
          else
            fail "Bedrock model for $MODEL not found in $REGION" "check llmModelId and region (the jp. profiles need Tokyo or Osaka); upgrade AWS CLI v2 to list profiles"
          fi
        elif [[ "$OUT" == *"AccessDenied"* || "$OUT" == *"UnauthorizedOperation"* ]]; then
          warn "not allowed to list Bedrock inference profiles (bedrock:ListInferenceProfiles); cannot check $MODEL" "add bedrock:ListInferenceProfiles to your identity, or ignore if the model already works for you"
        elif [[ "$OUT" == ACTIVE* ]]; then
          pass "Bedrock inference profile $MODEL is ACTIVE in $REGION"
          warn "Listing does not prove invoke permission: Anthropic models can still need a first-use form in the Bedrock console" "Bedrock console > Model catalog > open the model once; the deployed task role is scoped by the stack"
        else
          fail "Bedrock inference profile $MODEL not found in $REGION" "check llmModelId (a jp. profile id) and region; list: aws bedrock list-inference-profiles --region $REGION --type-equals SYSTEM_DEFINED"
        fi
      fi
      # Dictionaries
      DICT_FIX="cd cdk && ./scripts/dictionaries.sh   (creates both from dictionaries/; it writes to AWS, so run it yourself)"
      if [[ -n "$VOCAB" ]]; then
        VS="$(aws transcribe get-vocabulary --vocabulary-name "$VOCAB" --region "$REGION" --query VocabularyState --output text 2>/dev/null)"
        if [[ "$VS" == "READY" ]]; then pass "Transcribe vocabulary '$VOCAB' is READY"
        elif [[ -n "$VS" ]]; then warn "Transcribe vocabulary '$VOCAB' state is $VS" "wait until READY (aws transcribe get-vocabulary --vocabulary-name $VOCAB --region $REGION)"
        else fail "Transcribe vocabulary '$VOCAB' not found in $REGION" "$DICT_FIX; or set dictionaries.transcribeVocabulary to \"\" in event.json"; fi
      else
        warn "no Transcribe vocabulary configured (product names may be misrecognised)" "set dictionaries.transcribeVocabulary in event.json"
      fi
      if [[ -n "$TERM" ]]; then
        TN="$(aws translate list-terminologies --region "$REGION" --query "TerminologyPropertiesList[?Name=='$TERM'].Name" --output text 2>/dev/null)"
        if [[ -n "$TN" ]]; then pass "Translate terminology '$TERM' exists"; else
          fail "Translate terminology '$TERM' not found in $REGION" "$DICT_FIX; or set dictionaries.translateTerminology to \"\" in event.json (not allowed with translateEngine=llm)"; fi
      else
        warn "no Translate terminology configured" "set dictionaries.translateTerminology in event.json"
      fi
    fi
  fi
fi

echo
echo "Summary: $NPASS pass, $NWARN warn, $NFAIL fail"
[[ "$NFAIL" -eq 0 ]]
