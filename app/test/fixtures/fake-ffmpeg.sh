#!/bin/sh
# Fake ffmpeg for the gate test: writes PCM to stdout BEFORE its stderr lines (the ordering hole).
# FAKE_MODE=wrong: mismatch line, then Input line; FAKE_MODE=ok: Input line only; FAKE_MODE=silent: no stderr at all.
printf 'PCMPCMPCMPCM'
sleep 0.2
case "$FAKE_MODE" in
  wrong) echo "[rtmp @ 0x1] Unexpected stream SECRETNAME, expecting KEY" >&2; echo "Input #0, flv, from 'rtmp://x'" >&2 ;;
  ok) echo "Input #0, flv, from 'rtmp://x'" >&2 ;;
  silent) : ;;
esac
printf 'MOREMOREMORE'
sleep 6
