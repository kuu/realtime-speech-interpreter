#!/usr/bin/env bash
# Generate scripted test audio with Amazon Polly from samples/scripts/*.txt.
# Usage: ./samples/make-samples.sh [name ...]      (default: every script)
# Output (gitignored): samples/out/<name>.wav (16 kHz mono PCM) and samples/out/<name>.timeline.tsv
# Needs: AWS CLI v2 with credentials that allow polly:SynthesizeSpeech, and ffmpeg.
# Cost: Polly neural voices, about USD 16 per 1M characters (check current pricing). The three
# scripts together are about 5,000 characters, so a full run costs under 10 cents.
# Env: SAMPLES_REGION (default: AWS_REGION or ap-northeast-1), SAMPLES_GAP_SEC (pause between turns, default 0.6).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${SAMPLES_REGION:-${AWS_REGION:-ap-northeast-1}}"
GAP="${SAMPLES_GAP_SEC:-0.6}"
RATE=16000
OUT="$HERE/out"
for tool in aws ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found on PATH" >&2; exit 1; }
done
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$#" -gt 0 ]; then names=("$@"); else
  names=(); for f in "$HERE"/scripts/*.txt; do names+=("$(basename "$f" .txt)"); done
fi

# 16-bit mono silence of $GAP seconds
gap_bytes=$(awk -v g="$GAP" -v r="$RATE" 'BEGIN { printf "%d", int(g * r) * 2 }')
head -c "$gap_bytes" /dev/zero > "$TMP/gap.pcm"

for name in "${names[@]}"; do
  script="$HERE/scripts/$name.txt"
  [ -f "$script" ] || { echo "no such script: $script" >&2; exit 1; }
  raw="$TMP/$name.pcm"; : > "$raw"
  tl="$OUT/$name.timeline.tsv"; printf 'start_sec\tend_sec\tvoice\ttext\n' > "$tl"
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    voice="${line%%:*}"; text="${line#*: }"
    if ! [[ "$voice" =~ ^[A-Za-z]+$ ]] || [ "$text" = "$line" ]; then
      echo "$script: bad line (expected 'Voice: text'): $line" >&2; exit 1
    fi
    n=$((n + 1))
    aws polly synthesize-speech --region "$REGION" --engine neural --voice-id "$voice" \
      --output-format pcm --sample-rate "$RATE" --text-type text --text "$text" "$TMP/turn.pcm" >/dev/null
    start=$(( $(wc -c < "$raw") ))
    cat "$TMP/turn.pcm" >> "$raw"
    end=$(( $(wc -c < "$raw") ))
    awk -v s="$start" -v e="$end" -v v="$voice" -v t="$text" -v r="$RATE" \
      'BEGIN { printf "%.2f\t%.2f\t%s\t%s\n", s / (2 * r), e / (2 * r), v, t }' >> "$tl"
    cat "$TMP/gap.pcm" >> "$raw"
  done < "$script"
  ffmpeg -hide_banner -loglevel error -y -f s16le -ar "$RATE" -ac 1 -i "$raw" -c:a pcm_s16le "$OUT/$name.wav"
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT/$name.wav")
  printf '%s: %d turns, %.0f s -> %s\n' "$name" "$n" "$dur" "samples/out/$name.wav"
done
