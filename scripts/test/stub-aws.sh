#!/usr/bin/env bash
# A stub `aws` for scripts/test/doctor.test.mjs. Answers read-only calls from the environment and records every call
# in $STUB_AWS_LOG, so the test can assert that doctor never calls a write verb. Synthetic values only.
echo "$*" >> "${STUB_AWS_LOG:-/dev/null}"
case "$*" in
  *--version*) echo "aws-cli/2.17.0 Python/3.11.9 Linux/test source/x86_64" ;;
  "sts get-caller-identity"*) echo '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/Test/test"}' ;;
  "cloudformation describe-stacks"*) echo UPDATE_COMPLETE ;;
  "bedrock list-inference-profiles"*) echo ACTIVE ;;
  "transcribe get-vocabulary --vocabulary-name simul-translation "*"LanguageCode"*) echo "READY en-US" ;;
  "transcribe get-vocabulary --vocabulary-name simul-translation "*) echo READY ;;
  "transcribe get-vocabulary --vocabulary-name simul-translation-ja "*) echo "${STUB_VOCAB_JA:-READY ja-JP}" ;;
  "transcribe get-vocabulary --vocabulary-name missing-vocab "*) exit 255 ;;
  "translate list-terminologies"*) echo simul-translation ;;
  "translate get-terminology --name simul-translation "*) echo "en ja UNI" ;;
  "translate get-terminology --name simul-translation-ja-en "*) echo "${STUB_TERM_JA_EN:-ja en UNI}" ;;
  "translate get-terminology --name missing-term "*) exit 255 ;;
  "polly describe-voices --engine neural --language-code en-US"*) echo "${STUB_POLLY_EN-Joanna}" ;;
  "polly describe-voices --engine neural --language-code ja-JP"*) echo "${STUB_POLLY_JA-Kazuha}" ;;
  *) echo "stub aws: unexpected call: $*" >&2; exit 1 ;;
esac
