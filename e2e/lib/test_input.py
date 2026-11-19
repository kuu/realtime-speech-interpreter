"""Tests for `e2e.sh run --input srt|rtmps` (stdlib unittest, no AWS, no network).
Run: python3 -m unittest discover -s e2e/lib -p 'test_*.py'
`aws`, `ffmpeg` and `node` are stubs; the recorder and the stream are fakes.
"""
import contextlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import e2e
import report as rpt

KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3y12"  # fake test value
PASS = "Pass0Pass0Pass0Pass0Pass0Pass0Ab"  # fake test value
RTMPS_URL = "rtmps://rtmps.example.invalid:443/live"
SRT_TEMPLATE = "srt://203.0.113.20:9000?mode=caller&latency=120000&pbkeylen=16&passphrase=<passphrase>"


def script(path: Path, body: str) -> str:
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


class FakeStack:
    def __init__(self, outputs):
        self.outputs = outputs
        self.status = "UPDATE_COMPLETE"
        self.resources = []

    def out(self, key):
        v = self.outputs.get(key)
        if not v:
            raise e2e.Fail(f"stack output {key} missing")
        return v


RTMPS_OUTPUTS = {"RtmpsUrl": RTMPS_URL, "RtmpsStreamKeySecretArn": "arn:aws:secretsmanager:r:1:secret:k",
                 "LiveKitUrl": "wss://livekit.example.invalid", "ListenerUrl": "https://example.invalid/",
                 "AppLogGroupName": "/simul-translation/app", "LiveKitApiSecretArn": "arn:x",
                 "ObsSrtUrlTemplate": SRT_TEMPLATE, "SrtIngestIp2": "203.0.113.21",
                 "SrtPassphraseSecretArn": "arn:aws:secretsmanager:r:1:secret:p"}


class NormalizeTest(unittest.TestCase):
    def test_values(self):
        self.assertEqual(e2e.normalize_input("srt"), ("srt", None))
        self.assertEqual(e2e.normalize_input("RTMPS"), ("rtmps", None))
        canon, note = e2e.normalize_input("rtmp")
        self.assertEqual(canon, "rtmps")
        self.assertIn("RTMPS", note)

    def test_invalid(self):
        with self.assertRaises(e2e.Fail) as cm:
            e2e.normalize_input("udp")
        self.assertIn("srt, rtmps", str(cm.exception))


class ArgsTest(unittest.TestCase):
    def parse(self, *argv):
        seen = {}

        def fake_run(args):
            seen["args"] = args
            return 0

        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["e2e.sh", *argv]), mock.patch.object(e2e, "cmd_run", fake_run), \
                contextlib.redirect_stdout(out):
            rc = e2e.main()
        return rc, seen.get("args")

    def test_default_is_srt(self):
        rc, a = self.parse("run", "--file", "1")
        self.assertEqual((rc, a.input, a.input_note), (0, "srt", None))

    def test_rtmps_and_alias(self):
        _, a = self.parse("run", "--file", "1", "--input", "rtmps")
        self.assertEqual((a.input, a.input_note), ("rtmps", None))
        _, a = self.parse("run", "--file", "1", "--input", "rtmp")
        self.assertEqual(a.input, "rtmps")
        self.assertIn("RTMPS", a.input_note)

    def test_invalid_value_exits_2_listing_valid_values(self):
        err = io.StringIO()
        with mock.patch.object(sys, "argv", ["e2e.sh", "run", "--file", "1", "--input", "udp"]), \
                contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            e2e.main()
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("valid values are srt, rtmps", err.getvalue())

    def test_shell_entry_point_rejects_invalid(self):
        p = subprocess.run([str(e2e.E2E / "e2e.sh"), "run", "--file", "1", "--input", "tcp"],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("srt, rtmps", p.stderr)


class PreflightTest(unittest.TestCase):
    def run_check(self, outputs, kind):
        chk = e2e.Check(fix=False, yes=False, input_kind=kind)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            chk.input_outputs(FakeStack(outputs))
        return chk, out.getvalue()

    def test_rtmps_without_output_fails_clearly(self):
        chk, text = self.run_check({"ObsSrtUrlTemplate": SRT_TEMPLATE}, "rtmps")
        self.assertEqual(len(chk.reasons), 1)
        self.assertIn("inputSource=rtmps", text)
        self.assertIn("RtmpsUrl", text)

    def test_rtmps_with_outputs_passes(self):
        chk, _ = self.run_check(RTMPS_OUTPUTS, "rtmps")
        self.assertEqual((chk.reasons, chk.warnings), ([], []))
        self.assertEqual(chk.ctx["listenTags"], ("[rtmp]",))

    def test_srt_on_rtmps_stack_only_warns(self):
        chk, text = self.run_check(RTMPS_OUTPUTS, "srt")
        self.assertEqual(chk.reasons, [])
        self.assertEqual(len(chk.warnings), 1)
        self.assertIn("--input rtmps", text)

    def test_srt_on_plain_stack_is_silent(self):
        chk, _ = self.run_check({"ObsSrtUrlTemplate": SRT_TEMPLATE}, "srt")
        self.assertEqual((chk.reasons, chk.warnings), ([], []))
        self.assertEqual(chk.ctx["listenTags"], ("[srt]",))


class RunTest(unittest.TestCase):
    """Runs cmd_run end to end against stubs and checks what is printed and saved."""

    def setUp(self):
        e2e._SECRETS.clear()
        self.tmp = Path(tempfile.mkdtemp())
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        self.argv_log = self.tmp / "ffmpeg-argv.txt"
        # aws stub: secrets by id, everything else empty JSON. Never calls the network.
        script(bin_dir / "aws", f'''
case "$*" in
  *secret:k*) echo "{KEY}" ;;
  *secret:p*) echo "{PASS}" ;;
  *filter-log-events*) echo '{{"events":[]}}' ;;
  *) echo '{{}}' ;;
esac
''')
        # ffmpeg stub: clip extraction writes a file; the stream call records its argv, echoes the URL on stderr.
        self.ffmpeg = script(self.tmp / "ffmpeg", f'''
last="${{@: -1}}"
case "$*" in
  *"-f flv"*|*"-f mpegts"*) printf '%s\\n' "$@" > "{self.argv_log}"; echo "Failed to connect to $last" >&2; sleep 1; exit 0 ;;
  *) : > "$last" ;;
esac
''')
        # node stub: plays the recorder (reads credentials, says READY, waits for SIGINT)
        self.node = script(self.tmp / "node", '''
cat > /dev/null
echo "READY 1000"
echo "TRACK publisher-app"
trap 'exit 0' INT
while :; do sleep 0.2; done
''')
        self.runs = self.tmp / "runs"
        self.runs.mkdir()
        self.env = mock.patch.dict(os.environ, {"PATH": f"{bin_dir}:{os.environ['PATH']}"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_cmd(self, kind, outputs):
        chk = mock.Mock()
        chk.run.return_value = True
        chk.ctx = {"stack": FakeStack(outputs), "logStream": "app/app/t1", "taskId": "t1", "taskDefRevision": "7"}
        args = mock.Mock(input=kind, input_note=None, file="1", label="t", countdown=0, ingest=1, bitrate="128k",
                         drain_timeout=1)
        out = io.StringIO()
        patches = [
            mock.patch.object(e2e, "RUNS", self.runs),
            mock.patch.object(e2e, "find_ffmpeg", lambda *a: (self.ffmpeg, self.ffmpeg)),
            mock.patch.object(e2e, "app_deps_ok", lambda: True),
            mock.patch.object(e2e, "Check", lambda **kw: (setattr(chk, "kw", kw) or chk)),
            mock.patch.object(e2e, "clip_args", lambda a, p: (Path("/tmp/x.m4a"), 0.0, 3.0, 3.0)),
            mock.patch.object(e2e, "node_bin", lambda: self.node),
            mock.patch.object(e2e, "livekit_credentials", lambda arn: {"apiKey": "k", "apiSecret": "s"}),
            mock.patch.object(e2e, "_find_session", lambda *a, **k: None),
            mock.patch.object(e2e, "write_report", lambda *a, **k: {}),
            mock.patch.object(e2e, "_print_done", lambda d: None),
            mock.patch.object(e2e.time, "sleep", lambda s: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with contextlib.redirect_stdout(out):
            rc = e2e.cmd_run(args)
        return rc, out.getvalue(), chk

    def test_rtmps_run_keeps_key_out_of_output_and_files(self):
        rc, out, chk = self.run_cmd("rtmps", RTMPS_OUTPUTS)
        self.assertEqual(rc, 0)
        self.assertEqual(chk.kw["input_kind"], "rtmps")
        argv = self.argv_log.read_text().split()
        self.assertIn("flv", argv)
        self.assertIn("aac", argv)
        self.assertIn("-re", argv)  # real-time pacing
        self.assertEqual(argv[-1], f"{RTMPS_URL}/{KEY}")  # the stub did get the real URL
        self.assertIn(f"{RTMPS_URL}/***", out)
        self.assertNotIn(KEY, out)
        run_dir = next(self.runs.iterdir())
        meta = json.loads((run_dir / "meta.json").read_text())
        self.assertEqual(meta["input"], "rtmps")
        self.assertEqual(meta["rtmpsUrlRedacted"], f"{RTMPS_URL}/***")
        for f in run_dir.iterdir():
            self.assertNotIn(KEY.encode(), f.read_bytes(), f.name)  # includes stream.log (ffmpeg stderr)
            self.assertNotIn(PASS.encode(), f.read_bytes(), f.name)

    def test_srt_run_unchanged(self):
        rc, out, chk = self.run_cmd("srt", RTMPS_OUTPUTS)
        self.assertEqual(rc, 0)
        argv = self.argv_log.read_text().split()
        self.assertIn("libopus", argv)
        self.assertIn("mpegts", argv)
        self.assertTrue(argv[-1].startswith("srt://203.0.113.20:9000?"))
        self.assertNotIn(PASS, out)
        meta = json.loads((next(self.runs.iterdir()) / "meta.json").read_text())
        self.assertEqual(meta["input"], "srt")
        self.assertIn("srtUrlRedacted", meta)
        self.assertNotIn("rtmpsUrlRedacted", meta)

    def test_ingest_2_rejected_with_rtmps(self):
        with self.assertRaises(e2e.Fail):
            with mock.patch.object(e2e, "RUNS", self.runs):
                chk = mock.Mock()
                chk.run.return_value = True
                chk.ctx = {"stack": FakeStack(RTMPS_OUTPUTS), "logStream": "s"}
                with mock.patch.object(e2e, "find_ffmpeg", lambda *a: (self.ffmpeg, self.ffmpeg)), \
                        mock.patch.object(e2e, "app_deps_ok", lambda: True), \
                        mock.patch.object(e2e, "Check", lambda **kw: chk), \
                        mock.patch.object(e2e, "clip_args", lambda a, p: (Path("/tmp/x.m4a"), 0.0, 3.0, 3.0)):
                    e2e.cmd_run(mock.Mock(input="rtmps", input_note=None, ingest=2, file="1"))


class RtmpsTargetTest(unittest.TestCase):
    def test_rejects_odd_url_and_key(self):
        e2e._SECRETS.clear()
        with mock.patch.object(e2e, "get_secret_string", return_value="bad key/../x"):
            with self.assertRaises(e2e.Fail) as cm:
                e2e.rtmps_target(FakeStack(RTMPS_OUTPUTS))
            self.assertNotIn("bad key", str(cm.exception))
        with self.assertRaises(e2e.Fail):
            e2e.rtmps_target(FakeStack({**RTMPS_OUTPUTS, "RtmpsUrl": "http://x/live"}))


class ReportInputTest(unittest.TestCase):
    META = {"label": "t", "mode": "cloud", "clipDurationSec": 30, "taskDefRevision": "1", "taskId": "t"}

    def build(self, **extra):
        run = Path(tempfile.mkdtemp())
        text, data = rpt.build_report(run, {**self.META, **extra}, [], [], {}, run)
        return text, data["metrics"]

    def test_input_in_report_and_metrics(self):
        text, m = self.build(input="rtmps", rtmpsUrlRedacted=f"{RTMPS_URL}/***")
        self.assertIn("- Input: **rtmps**", text)
        self.assertIn(f"{RTMPS_URL}/***", text)
        self.assertEqual(m["input"], "rtmps")

    def test_older_runs_count_as_srt(self):
        text, m = self.build(srtUrlRedacted="srt://203.0.113.20:9000?passphrase=***")
        self.assertIn("(older run: assumed)", text)
        self.assertEqual(m["input"], "srt")

    def test_compare_warns_only_when_inputs_differ(self):
        a, b = {"file": "f", "clip": "c", "input": "srt"}, {"file": "f", "clip": "c", "input": "rtmps"}
        self.assertIn("different inputs", rpt.compare(Path("A"), Path("B"), a, b))
        self.assertNotIn("different inputs", rpt.compare(Path("A"), Path("B"), a, dict(a)))
        self.assertNotIn("different inputs", rpt.compare(Path("A"), Path("B"), a, {"file": "f", "clip": "c"}))


if __name__ == "__main__":
    unittest.main()
