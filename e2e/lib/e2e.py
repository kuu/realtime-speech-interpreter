#!/usr/bin/env python3
"""End-to-end test harness for the EN->JA simultaneous translation system.

Commands (see e2e/README.md):
  check     report (and with --fix, repair) the deployed system; prints READY / NOT READY
  run       cloud E2E: stream a recording over SRT (default) or RTMPS (--input) like OBS, record the LiveKit output
  local     offline E2E: run the app locally (INPUT_FILE + file sink) on the same clip
  report    regenerate report.md for a run folder (keeps the HUMAN JUDGEMENT section)
  compare   side-by-side metrics of two run folders -> compare.md
  langscan  locate Japanese speech in a recording with Transcribe language identification

Python stdlib only. AWS access goes through the AWS CLI. Secrets (SRT passphrase, RTMPS stream key, LiveKit API
secret) are fetched at runtime, kept in memory, redacted from every echoed line and never
written to disk.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from array import array
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bilingual  # noqa: E402
import report as rpt  # noqa: E402

LIB = Path(__file__).resolve().parent
E2E = LIB.parent
ROOT = E2E.parent
APP = ROOT / "app"
CDK = ROOT / "cdk"
# Recordings to feed the test: E2E_RECORDINGS=<dir> (files named NN_*.m4a), default <repo>/samples.
RECORDINGS = Path(os.environ.get("E2E_RECORDINGS") or (ROOT / "samples")).expanduser()
RUNS = E2E / "runs"
STACK = os.environ.get("E2E_STACK", "SimulTranslation")
REGION = os.environ.get("E2E_REGION") or os.environ.get("AWS_REGION") or "ap-northeast-1"
SRT_PORT_DEFAULT = 9000

# ---------------------------------------------------------------- output / secrets
_SECRETS: list[str] = []


def add_secret(s: str) -> None:
    if s and s not in _SECRETS:
        _SECRETS.append(s)
        enc = urllib.parse.quote(s, safe="")
        if enc != s:
            _SECRETS.append(enc)


def redact(text: str) -> str:
    for s in _SECRETS:
        text = text.replace(s, "***")
    return text


def say(msg: str = "") -> None:
    print(redact(msg), flush=True)


def status(tag: str, msg: str) -> None:
    say(f"[{tag:^4}] {msg}")


class Fail(Exception):
    pass


INPUTS = ("srt", "rtmps")
INPUT_ALIASES = {"rtmp": "rtmps"}


def normalize_input(value: str) -> tuple[str, str | None]:
    """Return (canonical input, note). 'rtmp' is accepted as an alias of 'rtmps'."""
    v = (value or "").strip().lower()
    if v in INPUT_ALIASES:
        c = INPUT_ALIASES[v]
        return c, f"--input {v}: RTMP without TLS is not offered; this means {c.upper()} (RTMP over TLS)."
    if v in INPUTS:
        return v, None
    raise Fail(f"invalid --input {value!r}: valid values are {', '.join(INPUTS)} (rtmp is an alias of rtmps)")


class _InputAction(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        try:
            canon, note = normalize_input(values)
        except Fail as e:
            parser.error(str(e))
        setattr(namespace, self.dest, canon)
        setattr(namespace, "input_note", note)


def confirm(question: str, yes: bool, allow_yes: bool = True) -> bool:
    if yes and allow_yes:
        say(f"  -> {question} [--yes: proceeding]")
        return True
    if not sys.stdin.isatty():
        say(f"  -> {question} [no terminal to confirm; skipped" + (" (use --yes)" if allow_yes else "") + "]")
        return False
    try:
        ans = input(redact(f"  -> {question} [y/N] ")).strip().lower()
    except EOFError:
        ans = ""
    return ans in ("y", "yes")


# ---------------------------------------------------------------- AWS CLI
def aws(*args: str, parse: bool = True, check: bool = True):
    cmd = ["aws", *args, "--region", REGION]
    if parse:
        cmd += ["--output", "json"]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        if check:
            raise Fail(redact(f"aws {' '.join(args[:2])} failed: {p.stderr.strip()[:500]}"))
        return None
    if not parse:
        return p.stdout
    return json.loads(p.stdout) if p.stdout.strip() else {}


def get_secret_string(arn: str) -> str:
    out = aws("secretsmanager", "get-secret-value", "--secret-id", arn, "--query", "SecretString",
              "--output", "text", parse=False)
    val = (out or "").strip()
    if not val:
        raise Fail("secret value is empty")
    add_secret(val)
    return val


def livekit_credentials(arn: str) -> dict:
    raw = get_secret_string(arn)
    try:
        d = json.loads(raw)
    except ValueError:
        raise Fail("LiveKit secret is not JSON")
    add_secret(d.get("apiSecret", ""))
    if not d.get("apiKey") or not d.get("apiSecret"):
        raise Fail("LiveKit secret lacks apiKey/apiSecret")
    return {"apiKey": d["apiKey"], "apiSecret": d["apiSecret"]}


class StackInfo:
    def __init__(self) -> None:
        d = aws("cloudformation", "describe-stacks", "--stack-name", STACK)
        s = d["Stacks"][0]
        self.status = s["StackStatus"]
        self.outputs = {o["OutputKey"]: o["OutputValue"] for o in s.get("Outputs", [])}
        res = aws("cloudformation", "list-stack-resources", "--stack-name", STACK)
        self.resources = res.get("StackResourceSummaries", [])

    def out(self, key: str) -> str:
        v = self.outputs.get(key)
        if not v:
            raise Fail(f"stack output {key} missing")
        return v

    def resource(self, rtype: str, prefix: str = "") -> str | None:
        for r in self.resources:
            if r["ResourceType"] == rtype and r["LogicalResourceId"].startswith(prefix):
                return r.get("PhysicalResourceId")
        return None


# ---------------------------------------------------------------- tools
def find_ffmpeg(need_srt: bool, need_rtmps: bool = False) -> tuple[str, str]:
    cands = [os.environ.get("FFMPEG", ""), shutil.which("ffmpeg") or "",
             "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/usr/local/opt/ffmpeg-full/bin/ffmpeg"]
    for c in cands:
        if not c or not os.path.exists(c):
            continue
        if need_srt:
            prot = subprocess.run([c, "-hide_banner", "-protocols"], capture_output=True, text=True).stdout
            enc = subprocess.run([c, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
            if not re.search(r"^\s*srt\s*$", prot, re.M) or "libopus" not in enc:
                continue
        if need_rtmps:
            prot = subprocess.run([c, "-hide_banner", "-protocols"], capture_output=True, text=True).stdout
            if not re.search(r"^\s*rtmps\s*$", prot, re.M):
                continue
        probe = str(Path(c).with_name("ffprobe"))
        if not os.path.exists(probe):
            probe = shutil.which("ffprobe") or ""
        if not probe:
            continue
        return c, probe
    if need_rtmps:
        raise Fail("no ffmpeg found with the rtmps protocol (TLS): `brew install ffmpeg` "
                   "(or set FFMPEG=/path/to/ffmpeg); check with: ffmpeg -hide_banner -protocols | grep rtmps")
    raise Fail("no ffmpeg found" + (" with SRT (libsrt) and libopus: `brew install ffmpeg-full` "
                                     "(or set FFMPEG=/path/to/ffmpeg)" if need_srt else ": `brew install ffmpeg`"))


def http_get(url: str, timeout: float = 10) -> tuple[int | None, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "simul-e2e-check"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def fetch_json(url: str, timeout: float = 10) -> dict | None:
    """GET a small JSON file (the listener page's config.json). None on any problem: the caller then records one track."""
    req = urllib.request.Request(url, headers={"User-Agent": "simul-e2e-check"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl.create_default_context()) as r:
            v = json.loads(r.read().decode("utf-8"))
            return v if isinstance(v, dict) else None
    except Exception:  # noqa: BLE001
        return None
def public_ip() -> str:
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10) as r:
        ip = r.read().decode().strip()
    addr = ipaddress.ip_address(ip)
    if addr.version != 4 or not addr.is_global:
        raise Fail(f"unexpected public IP {ip!r}")
    return str(addr)


def node_bin() -> str:
    n = shutil.which("node")
    if not n:
        raise Fail("node not found (Node 22 required)")
    return n


def app_deps_ok() -> bool:
    return (APP / "node_modules" / "@livekit" / "rtc-node").is_dir() and \
        (APP / "node_modules" / "livekit-server-sdk").is_dir()


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------- logs
def log_events(group: str, start_ms: int, end_ms: int | None = None, stream: str | None = None,
               pattern: str | None = None) -> list[tuple[int, str]]:
    args = ["logs", "filter-log-events", "--log-group-name", group, "--start-time", str(start_ms)]
    if end_ms:
        args += ["--end-time", str(end_ms)]
    if stream:
        args += ["--log-stream-names", stream]
    if pattern:
        args += ["--filter-pattern", pattern]
    d = aws(*args)
    ev = [(e["timestamp"], e["message"].rstrip("\n")) for e in d.get("events", [])]
    ev.sort(key=lambda x: x[0])
    return ev


def stream_head(group: str, stream: str, limit: int = 30) -> list[str]:
    d = aws("logs", "get-log-events", "--log-group-name", group, "--log-stream-name", stream,
            "--start-from-head", "--limit", str(limit))
    return [e["message"].rstrip("\n") for e in d.get("events", [])]


def stream_tail(group: str, stream: str, limit: int = 40) -> list[str]:
    d = aws("logs", "get-log-events", "--log-group-name", group, "--log-stream-name", stream,
            "--limit", str(limit))
    return [e["message"].rstrip("\n") for e in d.get("events", [])]


# ---------------------------------------------------------------- check
class Check:
    def __init__(self, fix: bool, yes: bool, quiet: bool = False, input_kind: str = "srt") -> None:
        self.fix, self.yes, self.quiet = fix, yes, quiet
        self.input_kind = input_kind
        self.reasons: list[str] = []
        self.warnings: list[str] = []
        self.ctx: dict = {}

    def ok(self, msg: str) -> None:
        status("OK", msg)

    def bad(self, msg: str, reason: str | None = None) -> None:
        status("FAIL", msg)
        self.reasons.append(reason or msg)

    def warn(self, msg: str) -> None:
        status("WARN", msg)
        self.warnings.append(msg)

    # -- individual checks
    def stack(self) -> StackInfo | None:
        try:
            st = StackInfo()
        except Fail as e:
            self.bad(f"Stack {STACK}: {e}", f"stack {STACK} not readable")
            return None
        s = st.status
        if s in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
            self.ok(f"Stack {STACK}: {s}")
        elif s == "UPDATE_ROLLBACK_COMPLETE":
            self.warn(f"Stack {STACK}: {s} (last deploy rolled back; previous version is running)")
        elif s.endswith("_IN_PROGRESS"):
            self.bad(f"Stack {STACK}: {s} (a deploy/update is running; wait for it to finish)", f"stack {s}")
        else:
            self.bad(f"Stack {STACK}: {s}", f"stack {s}")
        self.ctx["stack"] = st
        return st

    def input_outputs(self, st: StackInfo) -> None:
        """The stack must offer the chosen input. SRT with an RTMPS stack only warns (the SRT listener may be unused)."""
        has_rtmps = bool(st.outputs.get("RtmpsUrl"))
        self.ctx["listenTags"] = ("[rtmp]",) if self.input_kind == "rtmps" else \
            (("[srt]", "[rtmp]") if has_rtmps else ("[srt]",))
        if self.input_kind == "rtmps":
            missing = [k for k in ("RtmpsUrl", "RtmpsStreamKeySecretArn") if not st.outputs.get(k)]
            if missing:
                self.bad(f"Stack {STACK} has no {' / '.join(missing)} output: it was deployed without "
                         "-c inputSource=rtmps. Deploy it with that flag (keep your other -c settings), or use "
                         "--input srt",
                         "stack has no RTMPS input (deploy with -c inputSource=rtmps)")
                return
            self.ok("Stack offers RTMPS input (output RtmpsUrl)")
        elif has_rtmps:
            self.warn("Stack has an RtmpsUrl output (deployed with inputSource=rtmps): the SRT listener may not be "
                      "in use, so an SRT run can fail. Use --input rtmps if you meant RTMPS")

    def livekit_ec2(self, st: StackInfo) -> None:
        iid = st.out("LiveKitInstanceId")
        d = aws("ec2", "describe-instances", "--instance-ids", iid)
        state = d["Reservations"][0]["Instances"][0]["State"]["Name"]
        if state == "running":
            self.ok(f"LiveKit EC2 {iid}: running")
            return
        if state == "stopped" and self.fix:
            status("FIX", f"LiveKit EC2 {iid} is stopped. Will run: aws ec2 start-instances --instance-ids {iid} "
                          f"--region {REGION}, then wait until it is running and the TLS endpoint answers.")
            if confirm("Start the LiveKit instance?", self.yes):
                aws("ec2", "start-instances", "--instance-ids", iid)
                say("  waiting for instance-running ...")
                aws("ec2", "wait", "instance-running", "--instance-ids", iid, parse=False)
                url = "https://" + urllib.parse.urlparse(st.out("LiveKitUrl")).hostname + "/"
                deadline = time.time() + 300
                while time.time() < deadline:
                    code, _ = http_get(url, 5)
                    if code is not None:
                        break
                    time.sleep(10)
                self.ok(f"LiveKit EC2 {iid}: started")
                self.ctx["livekitRestarted"] = True
                return
        self.bad(f"LiveKit EC2 {iid}: {state}" + ("" if self.fix else "  (fix: ./e2e/e2e.sh check --fix)"),
                 f"LiveKit EC2 {state}")

    def livekit_tls(self, st: StackInfo) -> None:
        host = urllib.parse.urlparse(st.out("LiveKitUrl")).hostname
        url = f"https://{host}/"
        code, err = http_get(url)
        if code is not None:
            self.ok(f"LiveKit TLS endpoint {url} answered HTTP {code}")
            self.ctx["livekitUp"] = True
        else:
            self.bad(f"LiveKit TLS endpoint {url} did not answer ({err})", "LiveKit TLS endpoint down")
            self.ctx["livekitUp"] = False

    def listener_page(self, st: StackInfo) -> None:
        url = st.out("ListenerUrl")
        code, err = http_get(url)
        if code == 200:
            self.ok(f"Listener page {url} HTTP 200")
        else:
            self.bad(f"Listener page {url}: {code or err}", "listener page not HTTP 200")

    def _service(self, st: StackInfo) -> dict:
        d = aws("ecs", "describe-services", "--cluster", st.out("EcsClusterName"), "--services",
                st.out("EcsServiceName"))
        return d["services"][0]

    def _running_task(self, st: StackInfo) -> dict | None:
        cl = st.out("EcsClusterName")
        arns = aws("ecs", "list-tasks", "--cluster", cl, "--service-name", st.out("EcsServiceName"),
                   "--desired-status", "RUNNING").get("taskArns", [])
        if not arns:
            return None
        tasks = aws("ecs", "describe-tasks", "--cluster", cl, "--tasks", *arns).get("tasks", [])
        tasks.sort(key=lambda t: t.get("startedAt") or t.get("createdAt") or "", reverse=True)
        return tasks[0] if tasks else None

    def _startup(self, group: str, task_id: str) -> tuple[bool, bool, list[str]]:
        stream = f"app/app/{task_id}"
        try:
            head = stream_head(group, stream, 30)
        except Fail:
            head = []
        tags = self.ctx.get("listenTags", ("[srt]",))
        return (any("[livekit] connected" in m for m in head),
                any(f"{t} listening on port" in m for m in head for t in tags), head)

    def _wait_task_ready(self, st: StackInfo, not_task: str | None, timeout: int = 420) -> bool:
        group = st.out("AppLogGroupName")
        deadline = time.time() + timeout
        say("  waiting for a RUNNING task with startup lines ([livekit] connected, "
            f"{'/'.join(self.ctx.get('listenTags', ('[srt]',)))} listening) ...")
        while time.time() < deadline:
            t = self._running_task(st)
            if t and t.get("lastStatus") == "RUNNING" and t["taskArn"].split("/")[-1] != not_task:
                tid = t["taskArn"].split("/")[-1]
                lk, srt, _ = self._startup(group, tid)
                if lk and srt:
                    say(f"  task {tid} is running and started cleanly")
                    return True
            time.sleep(10)
        say("  timed out waiting for the task")
        return False

    def ecs(self, st: StackInfo) -> None:
        svc = self._service(st)
        cl, sv = st.out("EcsClusterName"), st.out("EcsServiceName")
        group = st.out("AppLogGroupName")
        desired, running, pending = svc["desiredCount"], svc["runningCount"], svc["pendingCount"]
        rev = svc["taskDefinition"].rsplit(":", 1)[-1]
        prim = next((d for d in svc.get("deployments", []) if d["status"] == "PRIMARY"), {})
        rollout = prim.get("rolloutState", "?")
        failed_tasks = prim.get("failedTasks", 0)
        line = (f"ECS service: desired={desired} running={running} pending={pending} taskDef revision={rev} "
                f"rollout={rollout}" + (f" failedTasks={failed_tasks}" if failed_tasks else ""))
        self.ctx["taskDefRevision"] = rev
        self.ctx["taskDefinitionArn"] = svc["taskDefinition"]
        if desired == 0:
            if self.fix:
                status("FIX", f"{line}. Will run: aws ecs update-service --cluster {cl} --service {sv} "
                              f"--desired-count 1 --region {REGION}, then wait for the task to start.")
                if confirm("Set desiredCount to 1?", self.yes):
                    aws("ecs", "update-service", "--cluster", cl, "--service", sv, "--desired-count", "1")
                    if self._wait_task_ready(st, None):
                        svc = self._service(st)
                        self.ok(f"ECS service: desired=1 running={svc['runningCount']} (started)")
                        return self._task(st, group)
                    self.bad("ECS task did not become ready after scaling to 1", "ECS task not ready")
                    return
            self.bad(line + ("" if self.fix else "  (service is scaled to 0; fix: ./e2e/e2e.sh check --fix)"),
                     "ECS desiredCount is 0")
            return
        # Crash loop: tasks keep stopping.
        # Crash loop: tasks keep stopping on their own (stops caused by deployments/scaling are ignored).
        # A replacement task may be RUNNING between crashes, so running == desired is not enough.
        stopped_recent = [t for t in self._recent_stopped(st)
                          if not str(t.get("stoppedReason", "")).startswith("Scaling activity")]
        if len(stopped_recent) >= 2 or (running < desired and failed_tasks):
            self.bad(line + f" — crash loop? {len(stopped_recent)} task(s) stopped in the last 30 min",
                     "ECS task crash-looping")
            self._print_crash(st, stopped_recent, group)
            return
        if running < desired:
            self.bad(line + " (task starting or not running; re-run check in a minute)", "ECS task not running")
            return
        self.ok(line)
        self._task(st, group)

    def _recent_stopped(self, st: StackInfo) -> list[dict]:
        cl = st.out("EcsClusterName")
        arns = aws("ecs", "list-tasks", "--cluster", cl, "--service-name", st.out("EcsServiceName"),
                   "--desired-status", "STOPPED").get("taskArns", [])
        if not arns:
            return []
        tasks = aws("ecs", "describe-tasks", "--cluster", cl, "--tasks", *arns[:100]).get("tasks", [])
        cutoff = time.time() - 1800
        out = []
        for t in tasks:
            ts = t.get("stoppedAt")
            if ts and _parse_aws_ts(ts) >= cutoff:
                out.append(t)
        out.sort(key=lambda t: t.get("stoppedAt", ""), reverse=True)
        return out

    def _print_crash(self, st: StackInfo, stopped: list[dict], group: str) -> None:
        for t in stopped[:2]:
            tid = t["taskArn"].split("/")[-1]
            cont = (t.get("containers") or [{}])[0]
            say(f"  stopped task {tid}: stoppedReason={t.get('stoppedReason')!r} exitCode={cont.get('exitCode')} "
                f"reason={cont.get('reason')!r}")
            try:
                lines = stream_tail(group, f"app/app/{tid}", 40)
            except Fail:
                lines = []
            say(f"  last {len(lines)} log lines of app/app/{tid}:")
            for m in lines:
                say("    " + m[:400])
        say("  Not repaired automatically: fix the cause (see the lines above), then redeploy with cdk "
            "or force a new deployment: aws ecs update-service --cluster "
            f"{st.out('EcsClusterName')} --service {st.out('EcsServiceName')} --force-new-deployment --region {REGION}")

    def _task(self, st: StackInfo, group: str) -> None:
        t = self._running_task(st)
        if not t:
            self.bad("No RUNNING task found", "no running task")
            return
        tid = t["taskArn"].split("/")[-1]
        self.ctx["taskId"] = tid
        self.ctx["logStream"] = f"app/app/{tid}"
        started = t.get("startedAt")
        age = time.time() - _parse_aws_ts(started) if started else 0
        lk, srt, head = self._startup(group, tid)
        self.ctx["startupLines"] = [m for m in head if rpt.RE_LINE.match(m)]
        problems = []
        if not (lk and srt):
            tag = "/".join(self.ctx.get("listenTags", ("[srt]",)))
            missing = [n for n, ok in (("[livekit] connected", lk), (f"{tag} listening on port", srt)) if not ok]
            if age < 120:
                self.warn(f"Task {tid} started {int(age)} s ago; startup lines not yet seen: {', '.join(missing)}")
            else:
                problems.append(f"startup lines missing in app/app/{tid}: {', '.join(missing)}")
        else:
            self.ok(f"Latest task {tid}: RUNNING since {started}; started cleanly ([livekit] connected, "
                    f"{'/'.join(self.ctx.get('listenTags', ('[srt]',)))} listening on port)")
        # NLB target health (the app's TCP health port)
        tg = st.resource("AWS::ElasticLoadBalancingV2::TargetGroup")
        if tg:
            th = aws("elbv2", "describe-target-health", "--target-group-arn", tg).get("TargetHealthDescriptions", [])
            states = [x["TargetHealth"]["State"] for x in th]
            if "healthy" in states:
                self.ok(f"NLB target health: {', '.join(states)}")
            elif age < 120 or "initial" in states:
                self.warn(f"NLB target health: {', '.join(states) or 'no targets'} (task is new)")
            else:
                problems.append(f"NLB target health: {', '.join(states) or 'no targets'}")
        # Publisher present in the LiveKit room?
        pub = self._publisher_present(st)
        if pub is True:
            self.ok(f"LiveKit room '{self.ctx.get('room', 'translation')}': publisher-app is publishing audio")
        elif pub is False:
            problems.append("app (publisher-app) is not publishing in the LiveKit room")
        # Is an SRT publisher (OBS) connected right now? (the session lines are SRT-specific)
        if self.input_kind == "srt":
            self._srt_idle(group, f"app/app/{tid}")
        if problems:
            msg = f"Task {tid} is RUNNING but unhealthy: " + "; ".join(problems)
            if self.fix:
                status("FIX", msg)
                status("FIX", f"Will run: aws ecs update-service --cluster {st.out('EcsClusterName')} --service "
                              f"{st.out('EcsServiceName')} --force-new-deployment --region {REGION} "
                              "(the old task stops first: about 1-3 min with no service), then wait for the new task.")
                if confirm("Force a new deployment?", self.yes):
                    aws("ecs", "update-service", "--cluster", st.out("EcsClusterName"), "--service",
                        st.out("EcsServiceName"), "--force-new-deployment")
                    if self._wait_task_ready(st, tid):
                        self.ok("New task started cleanly after force-new-deployment")
                        t2 = self._running_task(st)
                        if t2:
                            self.ctx["taskId"] = t2["taskArn"].split("/")[-1]
                            self.ctx["logStream"] = f"app/app/{self.ctx['taskId']}"
                            _, _, head2 = self._startup(group, self.ctx["taskId"])
                            self.ctx["startupLines"] = [m for m in head2 if rpt.RE_LINE.match(m)]
                        return
                    self.bad("New task did not become ready", "ECS task not ready after redeploy")
                    return
            self.bad(msg + ("" if self.fix else "  (fix: ./e2e/e2e.sh check --fix offers --force-new-deployment)"),
                     "ECS task unhealthy")

    def _publisher_present(self, st: StackInfo) -> bool | None:
        if not self.ctx.get("livekitUp"):
            return None
        if not app_deps_ok():
            self.warn("LiveKit room check skipped: app/node_modules missing (run: cd app && npm ci)")
            return None
        try:
            creds = livekit_credentials(st.out("LiveKitApiSecretArn"))
            p = subprocess.run([node_bin(), str(LIB / "recorder.cjs"), "probe", str(APP), st.out("LiveKitUrl"),
                                "translation"], input=json.dumps(creds), capture_output=True, text=True, timeout=30)
        except (Fail, subprocess.TimeoutExpired) as e:
            self.warn(f"LiveKit room check failed: {e}")
            return None
        try:
            d = json.loads(p.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            self.warn(f"LiveKit room check failed: {redact(p.stderr.strip()[:300])}")
            return None
        if not d.get("ok"):
            self.warn(f"LiveKit room check failed: {redact(str(d.get('error')))}")
            return None
        for part in d.get("participants", []):
            if part["identity"] == "publisher-app" and part.get("tracks"):
                return True
        return False

    def _srt_idle(self, group: str, stream: str) -> None:
        try:
            ev = log_events(group, now_ms() - 26 * 3600 * 1000, stream=stream,
                            pattern='?"first audio received" ?"stream ended" ?"listening on port"')
        except Fail as e:
            self.warn(f"SRT session state unknown: {e}")
            return
        if not ev:
            self.warn("SRT session state unknown (no session lines in the last 26 h)")
            return
        last = ev[-1][1]
        if "first audio received" in last:
            self.bad("An SRT publisher is connected right now (session in progress since "
                     f"{last[:24]}). Only one SRT publisher can be connected: stop OBS / other runs.",
                     "another SRT publisher is connected")
        else:
            self.ok("SRT listener idle (no publisher connected)")

    def rtmps_network(self, st: StackInfo) -> None:
        """RTMPS is TCP 443 on the LiveKit address, filtered by venueCidr in Caddy before TLS. Not editable here."""
        try:
            ip = public_ip()
        except Exception as e:  # noqa: BLE001
            self.bad(f"Could not determine this machine's public IP: {e}", "public IP unknown")
            return
        self.ctx["publicIp"] = ip
        self.warn(f"RTMPS needs this machine's public IP {ip} in the stack's venueCidr (checked by the LiveKit host "
                  "before TLS, not by this harness). If it is not, the connection is closed at once. Redeploy "
                  "with every allowed CIDR plus this one: cd cdk && npx cdk deploy -c inputSource=rtmps "
                  "-c venueCidr=<existing CIDRs>,<ip>/32")

    def sg(self, st: StackInfo) -> None:
        if self.input_kind == "rtmps":
            return self.rtmps_network(st)
        port = int(st.outputs.get("SrtPort", SRT_PORT_DEFAULT))
        try:
            ip = public_ip()
        except Exception as e:  # noqa: BLE001
            self.bad(f"Could not determine this machine's public IP: {e}", "public IP unknown")
            return
        self.ctx["publicIp"] = ip
        cidr = f"{ip}/32"
        assert ipaddress.ip_network(cidr).prefixlen == 32 and cidr != "0.0.0.0/32"
        sgs = {"NlbSg": st.resource("AWS::EC2::SecurityGroup", "NlbSg"),
               "AppSg": st.resource("AWS::EC2::SecurityGroup", "AppSg")}
        missing = []
        for name, gid in sgs.items():
            if not gid:
                self.bad(f"{name} not found in stack resources", f"{name} not found")
                return
            d = aws("ec2", "describe-security-groups", "--group-ids", gid)["SecurityGroups"][0]
            allowed = []
            hit = False
            for perm in d.get("IpPermissions", []):
                proto = perm.get("IpProtocol")
                if proto not in ("udp", "17", "-1"):
                    continue
                if proto != "-1" and not (perm.get("FromPort", 0) <= port <= perm.get("ToPort", -1)):
                    continue
                for r in perm.get("IpRanges", []):
                    allowed.append(r["CidrIp"])
                    if ipaddress.ip_address(ip) in ipaddress.ip_network(r["CidrIp"], strict=False):
                        hit = True
            self.ctx.setdefault("sgAllowed", {})[name] = allowed
            if not hit:
                missing.append((name, gid))
            say(f"       {name} {gid} UDP {port} allows: {', '.join(allowed) or '(none)'}")
        if not missing:
            self.ok(f"This machine's public IP {ip} is allowed on UDP {port} in NlbSg and AppSg")
            return
        cmds = [
            ["aws", "ec2", "authorize-security-group-ingress", "--region", REGION, "--group-id", gid,
             "--ip-permissions",
             f"IpProtocol=udp,FromPort={port},ToPort={port},IpRanges=[{{CidrIp={cidr},Description=e2e-manual}}]"]
            for _, gid in missing
        ]
        self.bad(f"This machine's public IP {ip} is NOT allowed on UDP {port} in "
                 f"{', '.join(n for n, _ in missing)}: SRT packets are silently dropped",
                 f"public IP {ip} not allowlisted for SRT")
        say("       To allow it, run (both SGs are needed: the NLB preserves the client IP):")
        for c in cmds:
            say("         " + " ".join(_shq(x) for x in c))
        existing = []
        for lst in self.ctx.get("sgAllowed", {}).values():
            existing += [c for c in lst if c not in existing and c != cidr]
        say("       NOTE: the next `cdk deploy` removes manually added rules unless the IP is in venueCidr.")
        say("       Keep EVERY CIDR allowed today (any CIDR left out is removed) and add the new one:")
        say(f"         cd {_shq(str(CDK))} && npx cdk deploy -c venueCidr={','.join(existing + [cidr])}")
        if self.fix:
            # Never covered by --yes: a security group change always needs an explicit answer.
            if confirm(f"Add {cidr} (UDP {port} only) to {', '.join(n for n, _ in missing)} now?", self.yes,
                       allow_yes=False):
                for c in cmds:
                    p = subprocess.run(c, capture_output=True, text=True)
                    if p.returncode != 0 and "InvalidPermission.Duplicate" not in p.stderr:
                        say("       failed: " + redact(p.stderr.strip()[:300]))
                        return
                say("       added; re-checking ...")
                self.reasons.pop()
                status("FIX", f"Added {cidr} UDP {port} to {', '.join(n for n, _ in missing)}")
                return self.sg(st)

    def run(self) -> bool:
        say(f"== E2E check: stack {STACK} ({REGION}){'  [--fix]' if self.fix else ''} ==")
        st = self.stack()
        if st:
            self.ctx["room"] = "translation"
            for fn in (self.input_outputs, self.livekit_ec2, self.livekit_tls, self.ecs, self.listener_page, self.sg):
                try:
                    fn(st)
                except Fail as e:
                    self.bad(f"{fn.__name__}: {e}", f"{fn.__name__} check error")
        ready = not self.reasons
        say("")
        if ready:
            say("RESULT: READY" + (f"  (warnings: {len(self.warnings)})" if self.warnings else ""))
        else:
            say("RESULT: NOT READY")
            for r in self.reasons:
                say(f"  - {r}")
            if not self.fix:
                say("  Repair: ./e2e/e2e.sh check --fix   (asks before every change)")
        return ready


def _parse_aws_ts(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _shq(s: str) -> str:
    return s if re.fullmatch(r"[\w./:=@,+-]+", s) else "'" + s.replace("'", "'\\''") + "'"


# ---------------------------------------------------------------- clip / files
def resolve_file(sel: str) -> Path:
    files = sorted(RECORDINGS.glob("*.m4a"))
    if re.fullmatch(r"\d", sel or ""):
        i = int(sel)
        for f in files:
            if f.name.startswith(f"{i:02d}_"):
                return f
        raise Fail(f"no recording with index {i} in {RECORDINGS}")
    p = Path(sel).expanduser()
    if p.exists():
        return p.resolve()
    hits = [f for f in files if sel.lower() in f.name.lower()]
    if len(hits) == 1:
        return hits[0]
    raise Fail(f"recording {sel!r} not found (use 1-4, a name fragment or a path)")


def parse_time(s: str | None) -> float | None:
    if s is None or s == "":
        return None
    s = s.strip().lower()
    if ":" in s:
        parts = [float(x) for x in s.split(":")]
        sec = 0.0
        for x in parts:
            sec = sec * 60 + x
        return sec
    m = re.fullmatch(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s?)?", s)
    if not m or not any(m.groups()):
        raise Fail(f"bad time {s!r} (examples: 00:05:00, 5:00, 300, 300s, 5m, 1h)")
    h, mi, se = (float(x) if x else 0.0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def probe_duration(ffprobe: str, f: Path) -> float:
    out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of",
                          "default=nw=1:nk=1", str(f)], capture_output=True, text=True).stdout.strip()
    return float(out)


def make_run_dir(label: str, f: Path, mode: str) -> Path:
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", label).strip("-") or mode
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    d = RUNS / f"{ts}_{label}_{f.stem[:40]}"
    d.mkdir(parents=True, exist_ok=False)
    return d


def extract_clip(ffmpeg: str, src: Path, start: float, dur: float, out: Path, rate: int, raw: bool = False) -> None:
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
            "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate)]
    args += (["-f", "s16le", "-acodec", "pcm_s16le"] if raw else ["-acodec", "pcm_s16le"]) + [str(out)]
    subprocess.run(args, check=True)


def wav_info(path: Path) -> tuple[int, int, float]:
    with wave.open(str(path), "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getnframes() / w.getframerate()


def volumedetect(ffmpeg: str, path: Path) -> str:
    p = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    mean = re.search(r"mean_volume: (-?[\d.]+) dB", p.stderr)
    mx = re.search(r"max_volume: (-?[\d.]+) dB", p.stderr)
    return f"mean {mean.group(1) if mean else '?'} dB, max {mx.group(1) if mx else '?'} dB"


def first_onset(path: Path, threshold: int = 1000, win_ms: int = 20) -> float | None:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = int(sr * win_ms / 1000)
        pos = 0
        while True:
            b = w.readframes(n)
            if not b:
                return None
            a = array("h")
            a.frombytes(b[: len(b) // 2 * 2])
            if a and max(max(a), -min(a)) > threshold:
                return pos / sr
            pos += len(a)


def write_wav(path: Path, pcm: bytes | bytearray, sr: int) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(pcm))


def side_by_side(ffmpeg: str, src: Path, trans: Path, out: Path, dur: float) -> None:
    fc = (f"[0:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,apad=whole_dur={dur:.3f}[l];"
          f"[1:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono,apad=whole_dur={dur:.3f}[r];"
          "[l][r]amerge=inputs=2[a]")
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-i", str(trans),
                    "-filter_complex", fc, "-map", "[a]", "-t", f"{dur:.3f}", "-c:a", "pcm_s16le", str(out)],
                   check=True)


def audio_summary(ffmpeg: str, run_dir: Path) -> dict:
    out = {}
    for name in ("source-clip.wav", "translation.wav", "side-by-side.wav"):
        p = run_dir / name
        if p.exists():
            sr, ch, d = wav_info(p)
            out[f"{name}"] = f"{d:.1f} s, {sr} Hz, {ch} ch, {volumedetect(ffmpeg, p)}"
    return out


def write_report(run_dir: Path, ffmpeg: str | None = None) -> dict:
    meta = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
    lines = (run_dir / "app.log").read_text(encoding="utf-8").splitlines()
    startup = []
    sp = run_dir / "startup.log"
    if sp.exists():
        startup = sp.read_text(encoding="utf-8").splitlines()
    if ffmpeg is None:
        ffmpeg, _ = find_ffmpeg(False)
    audio = audio_summary(ffmpeg, run_dir)
    audio.update(meta.get("audioChecks", {}))
    text, data = rpt.build_report(run_dir, meta, lines, startup, audio, RUNS)
    (run_dir / "report.md").write_text(redact(text), encoding="utf-8")
    (run_dir / "metrics.json").write_text(json.dumps(data["metrics"], ensure_ascii=False, indent=2), encoding="utf-8")
    # A run with a Japanese-source channel also gets the scoring sheet (30 chunks to score by hand).
    if bilingual.has_channels(lines) or bilingual.has_ja_source(lines):
        (run_dir / "scoring-sheet.md").write_text(redact(bilingual.scoring_sheet(lines)), encoding="utf-8")
    return data


def clip_args(args, ffprobe: str) -> tuple[Path, float, float, float]:
    f = resolve_file(args.file)
    total = probe_duration(ffprobe, f)
    start = parse_time(args.start) or 0.0
    dur = parse_time(args.duration)
    if start >= total:
        raise Fail(f"--start {start:.0f}s is beyond the end of {f.name} ({total:.0f}s)")
    dur = min(dur if dur else total - start, total - start)
    return f, start, dur, total


# ---------------------------------------------------------------- local mode
def cdk_env() -> tuple[dict, list[str]]:
    """App env as the CDK stack would set it, from cdk.json context + the stack's environment block."""
    ctx = json.loads((CDK / "cdk.json").read_text(encoding="utf-8")).get("context", {})
    src = (CDK / "lib" / "simul-translation-stack.ts").read_text(encoding="utf-8")
    m = re.search(r"taskDef\.addContainer\(.*?environment:\s*\{(.*?)\n\s*\},", src, re.S)
    if not m:
        raise Fail("could not find the container environment block in cdk/lib/simul-translation-stack.ts")
    env, notes = {}, []
    for line in m.group(1).splitlines():
        mm = re.match(r'\s*([A-Z][A-Z0-9_]*):\s*(.+?),?\s*(//.*)?$', line)
        if not mm:
            continue
        key, expr = mm.group(1), mm.group(2).rstrip(",").strip()
        if key.startswith(("SRT_", "LIVEKIT_")) or key in ("HEALTH_PORT",):
            continue
        if expr == "region":
            env[key] = REGION
            continue
        lit = re.fullmatch(r'"(.*)"', expr)
        if lit:
            env[key] = lit.group(1)
            continue
        cm = re.fullmatch(r'(?:String\()?cfg\.(\w+)\)?(?:\s*\|\|\s*"(.*)")?', expr)
        if cm:
            name, fallback = cm.group(1), cm.group(2)
            if name in ctx:
                v = ctx[name]
                v = ("true" if v else "false") if isinstance(v, bool) else str(v)
                env[key] = v if v != "" or fallback is None else fallback
            elif fallback is not None:
                env[key] = fallback
            else:
                notes.append(f"{key}: cdk.json has no '{name}' (lib/config.ts default applies on deploy; app default used locally)")
            continue
        notes.append(f"{key}: expression `{expr}` not evaluated (app default used locally)")
    return env, notes


def deployed_env() -> dict:
    st = StackInfo()
    svc = aws("ecs", "describe-services", "--cluster", st.out("EcsClusterName"), "--services",
              st.out("EcsServiceName"))["services"][0]
    td = aws("ecs", "describe-task-definition", "--task-definition", svc["taskDefinition"])["taskDefinition"]
    env = {e["name"]: e["value"] for e in td["containerDefinitions"][0].get("environment", [])}
    return {k: v for k, v in env.items() if not k.startswith(("SRT_", "LIVEKIT_")) and k != "HEALTH_PORT"}


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def build_local_translation(pcm_path: Path, parsed: dict, total_sec: float, sr: int = 16000) -> tuple[bytearray, int]:
    """Place each played chunk's PCM at the time a listener would have heard it.

    The file sink writes the PCM back-to-back without gaps; PLAYED lines give each chunk's size
    and e2eFirstWordMs, from which heardAt (relative to the session's first audio) is derived.
    """
    data = pcm_path.read_bytes() if pcm_path.exists() else b""
    played = [c for c in parsed["chunks"].values() if c["status"] == "played" and c.get("pcmBytes")]
    end_sec = max([total_sec] + [c.get("heardRel", 0) + c["pcmBytes"] / (2 * sr) for c in played]) + 1.0
    out = bytearray(int(end_sec * sr) * 2)
    off = 0
    cursor = 0
    overlaps = 0
    for c in played:
        piece = data[off: off + c["pcmBytes"]]
        off += c["pcmBytes"]
        pos = int(max(0.0, c.get("heardRel", 0.0)) * sr) * 2
        if pos < cursor:
            if cursor - pos > int(0.05 * sr) * 2:  # > 50 ms; smaller = ms rounding in the log
                overlaps += 1
            pos = cursor
        end = pos + len(piece)
        if end > len(out):
            out.extend(bytes(end - len(out)))
        out[pos:end] = piece
        cursor = end
    return out, overlaps


def cmd_local(args) -> int:
    ffmpeg, ffprobe = find_ffmpeg(False)
    f, start, dur, _ = clip_args(args, ffprobe)
    if not (APP / "node_modules").is_dir():
        raise Fail(f"{APP}/node_modules missing: run `cd {APP} && npm ci` first")
    if args.config == "deployed":
        env_cfg, notes, source = deployed_env(), [], "deployed ECS task definition environment"
    else:
        env_cfg, notes = cdk_env()
        source = "cdk/cdk.json context (what the next `cdk deploy` would run)"
    overrides = {}
    for kv in args.env or []:
        if "=" not in kv:
            raise Fail(f"--env needs KEY=VALUE, got {kv!r}")
        k, v = kv.split("=", 1)
        if k.startswith(("SRT_", "LIVEKIT_")):
            raise Fail(f"--env {k} is not used in local mode")
        overrides[k] = v
    run_dir = make_run_dir(args.label, f, "local")
    say(f"== local E2E run -> {run_dir}")
    say(f"   {f.name}  start={rpt.fmt_hms(start)}  duration={dur:.0f}s  config={source}")
    for n in notes:
        say(f"   note: {n}")
    clip = run_dir / "source-clip.wav"
    extract_clip(ffmpeg, f, start, dur, clip, 48000)
    raw_in = run_dir / ".input-16k.raw"
    out_pcm = run_dir / ".translation-raw.pcm"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(clip), "-ac", "1", "-ar", "16000",
                    "-f", "s16le", "-acodec", "pcm_s16le", str(raw_in)], check=True)
    say("   building app (npm run build) ...")
    b = subprocess.run(["npm", "run", "build"], cwd=APP, capture_output=True, text=True)
    if b.returncode != 0:
        say(b.stdout[-2000:] + b.stderr[-2000:])
        raise Fail("npm run build failed")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SRT_", "LIVEKIT_", "INPUT_FILE", "AUDIO_SINK",
                                                                    "OUTPUT_FILE"))}
    env.update(env_cfg)
    env.update(overrides)
    env.update(AWS_REGION=env.get("AWS_REGION", REGION), AUDIO_SINK="file", OUTPUT_FILE=str(out_pcm),
               INPUT_FILE=str(raw_in), HEALTH_PORT=str(free_port()), HEALTH_HOST="127.0.0.1")
    meta = dict(mode="local", label=args.label, file=str(f), fileStem=f.stem, clipStartSec=start, clipDurationSec=dur,
                startedAt=iso_now(), configSource=source, envOverrides=overrides,
                appEnv={k: env[k] for k in sorted(set(env_cfg) | set(overrides))}, command=sys.argv[1:])
    (run_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    say(f"   running the app locally for ~{dur:.0f}s of audio (real-time pace; Ctrl-C stops early) ...")
    log_f = open(run_dir / "app.log", "w", encoding="utf-8")
    proc = subprocess.Popen([node_bin(), "dist/main.js"], cwd=APP, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
    t_start = time.time()
    try:
        _pump_app_output(proc, log_f, t_start)
        proc.wait(timeout=dur + 600)
    except KeyboardInterrupt:
        say("   Ctrl-C: stopping the app (it plays out what is queued, max 8 s) ...")
        meta["note"] = "stopped early with Ctrl-C"
        proc.send_signal(signal.SIGINT)
        try:
            _pump_app_output(proc, log_f, t_start)
            proc.wait(timeout=20)
        except (KeyboardInterrupt, subprocess.TimeoutExpired):
            proc.kill()
    except subprocess.TimeoutExpired:
        proc.kill()
        meta["note"] = "app timed out and was killed"
    finally:
        if proc.poll() is None:
            proc.kill()
        log_f.close()
    say(f"   app exited code={proc.returncode}")
    lines = (run_dir / "app.log").read_text(encoding="utf-8").splitlines()
    parsed = rpt.parse_log(lines)
    pcm, overlaps = build_local_translation(out_pcm, parsed, dur)
    write_wav(run_dir / "translation.wav", pcm, 16000)
    raw_bytes = out_pcm.stat().st_size if out_pcm.exists() else 0
    played_bytes = sum(c["pcmBytes"] or 0 for c in parsed["chunks"].values() if c["status"] == "played")
    meta["audioChecks"] = {
        "translation.wav build": f"file sink wrote {raw_bytes} B; PLAYED lines account for {played_bytes} B; "
                                 f"chunks placed at their heard time (overlaps > 50 ms pushed later: {overlaps})",
    }
    meta["appExitCode"] = proc.returncode
    (run_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    sb_dur = max(dur, wav_info(run_dir / "translation.wav")[2])
    side_by_side(ffmpeg, clip, run_dir / "translation.wav", run_dir / "side-by-side.wav", sb_dur)
    for p in (raw_in, out_pcm):
        p.unlink(missing_ok=True)
    write_report(run_dir, ffmpeg)
    _print_done(run_dir)
    return 0 if proc.returncode == 0 else 1


def _pump_app_output(proc, log_f, t_start: float) -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        line = redact(line)
        log_f.write(line)
        _progress(line, t_start)


def _progress(line: str, t_start: float) -> None:
    m = rpt.RE_LINE.match(line.rstrip("\n"))
    if not m:
        return
    msg = m.group(3)
    el = rpt.fmt_hms(time.time() - t_start)
    if mm := rpt.RE_COMMIT.search(msg):
        say(f"   {el} [{mm.group(1)}] EN {mm.group(11)[:110]}")
    elif mm := rpt.RE_SYNTH.search(msg):
        lvl = f"L{mm.group('level')} " if mm.group("level") else ""
        say(f"   {el} [{mm.group('n')}] JA {mm.group('ja')[:80]} ({lvl}rate {mm.group('rate')}%)")
    elif "DROPPED" in msg or "FAILED" in msg or m.group(2) == "ERROR":
        say(f"   {el} {msg[:200]}")


def _print_done(run_dir: Path) -> None:
    say("")
    say(f"Done: {run_dir}")
    for n in ("translation.wav", "side-by-side.wav", "source-clip.wav", "app.log", "report.md"):
        say(f"   {run_dir / n}")
    say(f"Listen:  open '{run_dir / 'side-by-side.wav'}'   (left = English source, right = Japanese)")
    say(f"Judge:   fill in the HUMAN JUDGEMENT section of '{run_dir / 'report.md'}'")


# ---------------------------------------------------------------- cloud run
def rtmps_target(st: StackInfo) -> tuple[str, str]:
    """(base URL without key, full URL with key). The key is registered for redaction before it is used."""
    base = st.out("RtmpsUrl").rstrip("/")
    if not re.fullmatch(r"rtmps://[A-Za-z0-9.-]+(:\d+)?/[A-Za-z0-9_-]+", base):
        raise Fail("unexpected RtmpsUrl output (expected rtmps://<host>[:port]/<app>)")
    key = get_secret_string(st.out("RtmpsStreamKeySecretArn"))  # registers the key with add_secret
    if not re.fullmatch(r"[A-Za-z0-9]{8,128}", key):
        raise Fail("the RTMPS stream key secret has an unexpected format (expected letters and digits only)")
    return base, f"{base}/{key}"


def cmd_run(args) -> int:
    inp = getattr(args, "input", "srt")
    if getattr(args, "input_note", None):
        say(f"NOTE: {args.input_note}")
    ffmpeg, ffprobe = find_ffmpeg(inp == "srt", inp == "rtmps")
    f, start, dur, _ = clip_args(args, ffprobe)
    if not app_deps_ok():
        raise Fail(f"{APP}/node_modules missing (the recorder uses the app's LiveKit SDKs): cd {APP} && npm ci")
    chk = Check(fix=False, yes=False, input_kind=inp)
    if not chk.run():
        say("Refusing to stream: the system is NOT READY. Fix it first: ./e2e/e2e.sh check --fix")
        return 2
    st: StackInfo = chk.ctx["stack"]
    group = st.out("AppLogGroupName")
    stream = chk.ctx["logStream"]
    if inp == "srt":
        template = st.out("ObsSrtUrlTemplate")
        u = urllib.parse.urlparse(template)
        params = dict(urllib.parse.parse_qsl(u.query))
        if params.get("mode") != "caller" or "passphrase" not in params:
            raise Fail(f"unexpected ObsSrtUrlTemplate {template}")
        host = st.out("SrtIngestIp2") if args.ingest == 2 else u.hostname
        port = u.port or SRT_PORT_DEFAULT
    elif args.ingest == 2:
        raise Fail("--ingest 2 selects the second SRT ingest IP; it does not apply to --input rtmps")

    run_dir = make_run_dir(args.label, f, "cloud")
    say("")
    say(f"== cloud E2E run -> {run_dir}")
    say(f"   {f.name}  start={rpt.fmt_hms(start)}  duration={dur:.0f}s")
    clip = run_dir / "source-clip.wav"
    extract_clip(ffmpeg, f, start, dur, clip, 48000)
    (run_dir / "startup.log").write_text("\n".join(chk.ctx.get("startupLines", [])) + "\n", encoding="utf-8")

    creds = livekit_credentials(st.out("LiveKitApiSecretArn"))
    rec_wav = run_dir / ".recorder.wav"
    rec_log = open(run_dir / "recorder.log", "w", encoding="utf-8")
    max_sec = int(dur + args.drain_timeout + args.countdown + 120)
    # A two-lane deploy lists its channels in config.json: record each channel's track into its own file.
    site = fetch_json(st.out("ListenerUrl").rstrip("/") + "/config.json")
    chans = bilingual.listener_channels(site)
    rec_paths = {c["id"]: run_dir / f".recorder-{c['id']}.wav" for c in chans}
    rec_extra = [bilingual.tracks_json(chans, {k: str(v) for k, v in rec_paths.items()})] if chans else []
    if chans:
        say(f"   two channels: recording {', '.join(c['id'] for c in chans)} to {', '.join(bilingual.wav_name(c['id']) for c in chans)}")
    rec = subprocess.Popen([node_bin(), str(LIB / "recorder.cjs"), "record", str(APP), st.out("LiveKitUrl"),
                            "translation", str(rec_wav), str(max_sec), *rec_extra],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                           bufsize=1, start_new_session=True)
    ff = None
    meta = dict(mode="cloud", input=inp, label=args.label, file=str(f), fileStem=f.stem, clipStartSec=start, clipDurationSec=dur,
                startedAt=iso_now(), taskDefRevision=chk.ctx.get("taskDefRevision"), taskId=chk.ctx.get("taskId"),
                logStream=stream, command=sys.argv[1:], japaneseOnly=bool(getattr(args, "japanese_only", False)),
                channels=[c["id"] for c in chans],
                configSource=f"deployed task definition revision {chk.ctx.get('taskDefRevision')}")
    try:
        assert rec.stdin is not None and rec.stdout is not None
        rec.stdin.write(json.dumps(creds))
        rec.stdin.close()
        del creds
        rec_state = {"ready": None, "track": None, "lines": []}
        threading.Thread(target=_read_recorder, args=(rec, rec_log, rec_state), daemon=True).start()
        deadline = time.time() + 30
        while time.time() < deadline and rec_state["ready"] is None and rec.poll() is None:
            time.sleep(0.2)
        if rec_state["ready"] is None:
            raise Fail("recorder did not join the LiveKit room: " + " | ".join(rec_state["lines"][-5:]))
        t = time.time() + 10
        while time.time() < t and rec_state["track"] is None:
            time.sleep(0.2)
        if rec_state["track"] is None:
            say("   WARNING: recorder joined but has not subscribed to an audio track yet")
        else:
            say(f"   recorder subscribed to {rec_state['track']}'s audio track")

        say("")
        say(f"   LISTENER PAGE: {st.out('ListenerUrl')}")
        say("   Open it on a phone/laptop with headphones and tap the button. Make sure OBS is NOT streaming.")
        if sys.stdout.isatty():
            for i in range(args.countdown, 0, -1):
                sys.stdout.write(f"\r   streaming starts in {i:2d} s (Ctrl-C to abort) ")
                sys.stdout.flush()
                time.sleep(1)
            sys.stdout.write("\n")
        else:
            say(f"   streaming starts in {args.countdown} s (Ctrl-C to abort)")
            time.sleep(args.countdown)

        if inp == "rtmps":
            base, url = rtmps_target(st)
            meta["rtmpsUrlRedacted"] = redact(url)
            # Same shape as an OBS RTMPS stream: AAC, 48 kHz, mono, FLV; -re paces it at real time.
            ff_cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostats", "-re", "-i", str(clip), "-vn",
                      "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", args.bitrate, "-f", "flv", url]
        else:
            passphrase = get_secret_string(st.out("SrtPassphraseSecretArn"))
            q = dict(params)
            q["passphrase"] = passphrase
            url = f"srt://{host}:{port}?" + urllib.parse.urlencode(q)
            del passphrase
            meta["srtUrlRedacted"] = redact(url)
            ff_cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostats", "-re", "-i", str(clip), "-vn",
                      "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", args.bitrate, "-f", "mpegts", url]
        meta["ffmpegCommand"] = redact(" ".join(_shq(x) for x in ff_cmd))
        say(f"   $ {meta['ffmpegCommand']}")
        stream_start = now_ms()
        meta["streamStartEpochMs"] = stream_start
        meta["recStartEpochMs"] = rec_state["ready"]
        ff = subprocess.Popen(ff_cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              text=True, start_new_session=True)
        del url, ff_cmd
        ff_err: list[str] = []
        threading.Thread(target=_read_ffmpeg, args=(ff, run_dir / "stream.log", ff_err), daemon=True).start()
        interrupted = False
        session = None
        try:
            last = 0.0
            while ff.poll() is None:
                time.sleep(1)
                el = time.time() - stream_start / 1000
                if el - last >= 30:
                    last = el
                    if session is None:
                        session = _find_session(group, stream, stream_start)
                    say(f"   streaming {rpt.fmt_hms(el)} / {rpt.fmt_hms(dur)}" +
                        (f"  (app session {session})" if session else "  (app has not reported audio yet)"))
                    if session is None and el > 45:
                        say("   ERROR: the app has not received audio after 45 s. Likely: " + (
                            "this IP is not in venueCidr, a wrong stream key, or another RTMPS publisher is "
                            "connected. Stopping." if inp == "rtmps" else
                            "this IP is blocked by the SGs, a wrong passphrase, or another SRT publisher (OBS) "
                            "is connected. Stopping."))
                        ff.terminate()
                        meta["note"] = "app received no audio; stream aborted"
        except KeyboardInterrupt:
            interrupted = True
            say("\n   Ctrl-C: stopping the stream; draining and collecting what was translated ...")
            ff.terminate()
            meta["note"] = "stream stopped early with Ctrl-C"
        ff.wait()
        stream_end = now_ms()
        meta["streamEndEpochMs"] = stream_end
        meta["ffmpegExitCode"] = ff.returncode
        sent = (stream_end - stream_start) / 1000
        say(f"   ffmpeg exited code={ff.returncode} after {sent:.1f} s")
        if ff.returncode not in (0, 255) and not interrupted:
            for line in ff_err[-10:]:
                say("   ffmpeg: " + line)
            if sent < 15 and inp == "rtmps":
                say("   Hint: an immediate RTMPS failure usually means this IP is not in venueCidr (the "
                    "connection is closed before TLS), the stack was not deployed with -c inputSource=rtmps, or "
                    "another encoder (OBS) is publishing. See README troubleshooting.")
            elif sent < 15:
                say("   Hint: an immediate SRT failure usually means this IP is not allowlisted, the passphrase is "
                    "wrong, or another publisher holds the listener (stop OBS). See README troubleshooting.")
        session = session or _find_session(group, stream, stream_start, wait=20)
        meta["session"] = session
        if session:
            _drain(group, stream, stream_start, session, args.drain_timeout)
        else:
            say("   the app never reported a session for this stream; no translation to collect")
        time.sleep(3)  # last chunk's audio is still in LiveKit's ~1 s playout queue
    finally:
        if ff and ff.poll() is None:
            ff.kill()
        if rec.poll() is None:
            rec.send_signal(signal.SIGINT)
            try:
                rec.wait(timeout=20)
            except subprocess.TimeoutExpired:
                rec.kill()
        time.sleep(0.3)
        rec_log.close()

    # Collect this session's log lines by time window.
    end_ms = now_ms() + 1000
    ev = log_events(group, meta["streamStartEpochMs"] - 2000 if "streamStartEpochMs" in meta else now_ms(), end_ms,
                    stream=stream)
    (run_dir / "app.log").write_text(redact("\n".join(m for _, m in ev) + "\n"), encoding="utf-8")
    say(f"   collected {len(ev)} log lines from {group} {stream}")

    # Two channels: translation-<id>.wav per channel, each re-based like translation.wav below.
    if chans and "streamStartEpochMs" in meta:
        checks = {}
        for c in chans:
            rp = rec_paths[c["id"]]
            if not rp.exists():
                checks[f"recorder {c['id']}"] = "no recording (the channel's track was not subscribed)"
                continue
            sr, _, rec_dur = wav_info(rp)
            with wave.open(str(rp), "rb") as w:
                pcm = w.readframes(w.getnframes())
            offset_ms = meta["recStartEpochMs"] - meta["streamStartEpochMs"]
            shift = int(abs(offset_ms) * sr / 1000) * 2
            pcm = (bytes(shift) + pcm) if offset_ms >= 0 else pcm[shift:]
            out_wav = run_dir / bilingual.wav_name(c["id"])
            write_wav(out_wav, pcm, sr)
            rp.unlink()
            checks[f"recorder {c['id']}"] = f"{rec_dur:.1f} s recorded"
            side_by_side(ffmpeg, clip, out_wav, run_dir / f"side-by-side-{c['id']}.wav", max(dur, wav_info(out_wav)[2]))
        meta["audioChecks"] = checks
    # translation.wav: recorder output re-based so sample 0 = stream start (wall clock).
    elif rec_wav.exists() and "streamStartEpochMs" in meta:
        sr, _, rec_dur = wav_info(rec_wav)
        with wave.open(str(rec_wav), "rb") as w:
            pcm = w.readframes(w.getnframes())
        offset_ms = meta["recStartEpochMs"] - meta["streamStartEpochMs"]
        shift = int(abs(offset_ms) * sr / 1000) * 2
        pcm = (bytes(shift) + pcm) if offset_ms >= 0 else pcm[shift:]
        write_wav(run_dir / "translation.wav", pcm, sr)
        rec_wav.unlink()
        lines = (run_dir / "app.log").read_text(encoding="utf-8").splitlines()
        parsed = rpt.parse_log(lines)
        played = [c for c in parsed["chunks"].values() if c.get("heardRel") is not None]
        onset = first_onset(run_dir / "translation.wav")
        checks = {"recorder": f"{rec_dur:.1f} s recorded; recorder joined {offset_ms / -1000:.1f} s before the stream"}
        if played and onset is not None:
            # heardAt (epoch) of the first played chunk vs the first loud sample in the recording.
            c = played[0]
            predicted = (c["t0"] + c["a0"] * 1000 + c["e2e"] - meta["streamStartEpochMs"]) / 1000
            checks["alignment"] = (f"first Japanese audio heard at {onset:.2f} s in translation.wav; app predicted "
                                   f"{predicted:.2f} s (difference {onset - predicted:+.2f} s = network + playout)")
        meta["audioChecks"] = checks
        dur_sb = max(dur, wav_info(run_dir / "translation.wav")[2])
        side_by_side(ffmpeg, clip, run_dir / "translation.wav", run_dir / "side-by-side.wav", dur_sb)
    else:
        meta["note"] = (meta.get("note", "") + "; no recording produced").strip("; ")
    (run_dir / "meta.json").write_text(redact(json.dumps(meta, ensure_ascii=False, indent=2)), encoding="utf-8")
    write_report(run_dir, ffmpeg)
    _print_done(run_dir)
    return 0


def _read_recorder(rec, log_f, state) -> None:
    for line in rec.stdout:
        line = redact(line.rstrip("\n"))
        log_f.write(line + "\n")
        log_f.flush()
        state["lines"].append(line)
        if line.startswith("READY "):
            state["ready"] = int(line.split()[1])
        elif line.startswith("TRACK "):
            state["track"] = line.split()[1]
        elif line.startswith(("recorder error", "recorder:", "UNTRACK")):
            say("   " + line)


def _read_ffmpeg(ff, path: Path, sink: list[str]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for line in ff.stderr:
            line = redact(line.rstrip("\n"))
            fh.write(line + "\n")
            sink.append(line)


def _find_session(group: str, stream: str, start_ms: int, wait: int = 0) -> int | None:
    deadline = time.time() + wait
    while True:
        try:
            ev = log_events(group, start_ms - 2000, stream=stream, pattern='"first audio received"')
        except Fail:
            ev = []
        for _, m in ev:
            mm = rpt.RE_SESSION_START.search(m)
            if mm:
                return int(mm.group(1))
        if time.time() >= deadline:
            return None
        time.sleep(5)


def _drain(group: str, stream: str, start_ms: int, session: int, timeout: int) -> None:
    """Wait until the session summary is logged and every committed chunk reached a final state."""
    say(f"   waiting for the backlog to drain (session {session}; timeout {timeout} s) ...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ev = log_events(group, start_ms - 2000, stream=stream)
        except Fail:
            time.sleep(5)
            continue
        lines = [m for _, m in ev]
        summary = any(f"[summary] session={session} " in m for m in lines)
        parsed = rpt.parse_log(lines)
        open_chunks = [c["n"] for c in parsed["chunks"].values() if c["status"] in ("queued", "synth")]
        last_played = max((c.get("playedTs", 0) for c in parsed["chunks"].values()), default=0)
        if summary and not open_chunks and now_ms() - last_played > 3000:
            say(f"   drained: summary logged, {len(parsed['chunks'])} chunks finished")
            return
        say(f"   ... summary={'yes' if summary else 'no'} unfinished chunks={len(open_chunks)}")
        time.sleep(5)
    say("   drain timeout: collecting what is there")


# ---------------------------------------------------------------- report / compare / langscan
def cmd_report(args) -> int:
    d = Path(args.run_dir).expanduser().resolve()
    write_report(d)
    say(f"wrote {d / 'report.md'}")
    return 0


def cmd_compare(args) -> int:
    a, b = (Path(x).expanduser().resolve() for x in (args.run_a, args.run_b))
    ma, mb = (write_report(d)["metrics"] for d in (a, b))
    text = rpt.compare(a, b, ma, mb)
    # Japanese segmentation reasons side by side (empty unless a run has a Japanese-source channel).
    read = lambda d: (d / "app.log").read_text(encoding="utf-8").splitlines() if (d / "app.log").exists() else []  # noqa: E731
    text += bilingual.compare_section(read(a), read(b))
    out = Path(args.out).expanduser() if args.out else RUNS / f"compare_{a.name}__vs__{b.name}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(text)
    say(f"wrote {out}")
    return 0


def _langscan_one(ffmpeg: str, ffprobe: str, sel: str, start_s: str | None, dur_s: str | None) -> tuple[Path, list[dict]]:
    f = resolve_file(sel)
    total = probe_duration(ffprobe, f)
    start = parse_time(start_s) or 0.0
    dur = min(parse_time(dur_s) or (total - start), total - start)
    d = RUNS / rpt.LANGSCAN_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    whole = start == 0 and dur >= total - 0.5
    name = f.stem if whole else f"{f.stem}_{int(start)}s_{int(dur)}s"
    raw = d / f".{name}.raw"
    extract_clip(ffmpeg, f, start, dur, raw, 16000, raw=True)
    out = d / f"{name}.jsonl"
    entries = []
    try:
        p = subprocess.Popen([node_bin(), str(LIB / "langscan.cjs"), str(APP), str(raw)], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env={**os.environ, "AWS_REGION": REGION})
        with open(out, "w", encoding="utf-8") as fh:
            for line in p.stdout:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                e["start"] = round(e["start"] + start, 2)
                e["end"] = round(e["end"] + start, 2)
                entries.append(e)
                fh.write(json.dumps(e, ensure_ascii=False) + "\n")
                fh.flush()
        p.wait()
        if p.returncode != 0:
            say(f"   langscan {f.name}: {redact(p.stderr.read().strip()[:300])}")
    finally:
        raw.unlink(missing_ok=True)
    return out, entries


def cmd_langscan(args) -> int:
    ffmpeg, ffprobe = find_ffmpeg(False)
    sels = ["1", "2", "3", "4"] if args.file == "all" else [args.file]
    results: dict = {}

    def work(sel):
        results[sel] = _langscan_one(ffmpeg, ffprobe, sel, args.start, args.duration)

    say(f"langscan: streaming {', '.join(sels)} to Transcribe (en-US/ja-JP language ID) at real-time pace ...")
    threads = [threading.Thread(target=work, args=(s,)) for s in sels]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    md = ["# Language scan (Transcribe streaming, IdentifyMultipleLanguages en-US + ja-JP)", ""]
    for sel in sels:
        out, entries = results[sel]
        rng = rpt.ja_ranges(entries)
        md.append(f"## {out.stem}")
        md.append("")
        md.append(f"{len(entries)} final results; ja-JP: {sum(1 for e in entries if e.get('lang') == 'ja-JP')}; "
                  f"ranges (merged when < 8 s apart):")
        md.append("")
        md.append("| Start | End | Results | Text (Transcribe ja-JP) |")
        md.append("|---|---|---|---|")
        for r in rng:
            md.append(f"| {rpt.fmt_hms(r['start'])} ({r['start']:.0f}s) | {rpt.fmt_hms(r['end'])} ({r['end']:.0f}s) | "
                      f"{r['n']} | {rpt._md(' '.join(r['text']))[:300]} |")
        md.append("")
    text = "\n".join(md)
    out_md = RUNS / rpt.LANGSCAN_DIRNAME / ("langscan.md" if args.file == "all" else f"langscan_{results[sels[0]][0].stem}.md")
    out_md.write_text(text, encoding="utf-8")
    print(text)
    say(f"wrote {out_md}")
    return 0


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(prog="e2e.sh", description="E2E test harness for the simultaneous translation system")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", aliases=["ensure-running"], help="report (and with --fix repair) the deployed system")
    c.add_argument("--fix", action="store_true", help="offer repairs (each asks for confirmation)")
    c.add_argument("--input", action=_InputAction, default="srt", metavar="{srt,rtmps}",
                   help="input to check the stack for: srt (default) or rtmps (alias: rtmp)")
    c.add_argument("--yes", action="store_true", help="skip confirmations for ECS/EC2 repairs (never for SG changes)")

    def clip_opts(p, need_label=True):
        p.add_argument("file_pos", nargs="?", metavar="FILE", help="recording: 1-4, name fragment or path")
        p.add_argument("--file", dest="file_opt", help="same as FILE")
        p.add_argument("--start", default=None, help="offset, e.g. 00:05:00, 5m, 300")
        p.add_argument("--duration", default=None, help="e.g. 5m, 90s, 00:02:00 (default: to the end)")
        if need_label:
            p.add_argument("--label", default=None, help="run name, e.g. baseline, ja-filter-v1")

    r = sub.add_parser("run", help="cloud E2E: stream a recording to the deployed system over SRT or RTMPS")
    r.add_argument("--input", action=_InputAction, default="srt", metavar="{srt,rtmps}",
                   help="how the audio is delivered: srt (default) or rtmps (alias: rtmp, which means RTMPS)")
    r.set_defaults(input_note=None)
    clip_opts(r)
    r.add_argument("--countdown", type=int, default=10, help="seconds before streaming starts (default 10)")
    r.add_argument("--ingest", type=int, choices=(1, 2), default=1, help="which SRT ingest IP (default 1)")
    r.add_argument("--bitrate", default="128k", help="Opus (srt) or AAC (rtmps) bitrate (default 128k)")
    r.add_argument("--drain-timeout", type=int, default=180, help="max seconds to wait for the backlog (default 180)")
    r.add_argument("--japanese-only", action="store_true",
                   help="the recording is Japanese speech only (samples/scripts/monologue-ja.txt): the report is about the "
                        "Japanese-source channel and a scoring sheet is written (the run streams what you pass; nothing else)")

    lo = sub.add_parser("local", help="offline E2E: run the app locally on the same clip (no deployed stack)")
    clip_opts(lo)
    lo.add_argument("--config", choices=("cdk", "deployed"), default="cdk",
                    help="app settings: cdk = cdk/cdk.json (default), deployed = current ECS task definition")
    lo.add_argument("--env", action="append", metavar="KEY=VALUE", help="extra app env override (repeatable)")

    rp = sub.add_parser("report", help="regenerate report.md for a run folder")
    rp.add_argument("run_dir")

    cp = sub.add_parser("compare", help="compare two run folders")
    cp.add_argument("run_a")
    cp.add_argument("run_b")
    cp.add_argument("--out", help="output path (default e2e/runs/compare_<A>__vs__<B>.md)")

    ls = sub.add_parser("langscan", help="locate Japanese speech with Transcribe language identification")
    ls.add_argument("file", help="1-4, name fragment, path, or 'all'")
    ls.add_argument("--start", default=None)
    ls.add_argument("--duration", default=None)

    args = ap.parse_args()
    if args.cmd in ("run", "local"):
        args.file = args.file_opt or args.file_pos
        if not args.file:
            ap.error("a recording is required: FILE or --file (1-4, name fragment or path)")
        if not args.label:
            args.label = "cloud" if args.cmd == "run" else "local"
    try:
        if args.cmd in ("check", "ensure-running"):
            if getattr(args, "input_note", None):
                say(f"NOTE: {args.input_note}")
            return 0 if Check(args.fix, args.yes, input_kind=args.input).run() else 1
        return {"run": cmd_run, "local": cmd_local, "report": cmd_report, "compare": cmd_compare,
                "langscan": cmd_langscan}[args.cmd](args)
    except Fail as e:
        say(f"ERROR: {e}")
        return 1
    except KeyboardInterrupt:
        say("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
