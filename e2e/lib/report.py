"""Log parsing, run reports and run comparison for the E2E harness (Python stdlib only).

Parses the app's per-chunk log lines (formats):
  [chunk N] COMMIT reason=... words=... [merged=K] result=... audio=A-Bs commitLagMs=... queueDepth=... en="..."
  [chunk N] SYNTH translateMs=... synthMs=... [level=L] rate=R backlogMs=... [signalMs=... estMs=... speedWhy=W] ... audioMs=... ja="..."
  [chunk N] PLAYED writtenBytes=... pcmBytes=... waitMs=... backlogMs=... e2eFirstWordMs=... e2eLastWordMs=...
  [chunk N] DROPPED / SKIPPED / FAILED ...
  LLM engine (TRANSLATE_ENGINE=llm; the fields are absent on older logs):
  [chunk N] SYNTH ... engine=llm|translate|fallback [fallbackReason=R] [llmMs=N inTok=N outTok=N cacheRead=N cacheWrite=N] ...
  [chunk N] LLM_FALLBACK reason=R ... / [chunk N] LLM_REJECT rule=R ... / [llm] BREAKER open reason=R forMs=N
  [llm-summary] session=N|exit engine=llm used=N fallback=N ... estUsd=X   (process-cumulative, like [summary])
  Sentence start lag (computed, no log field): see sentence_starts() / stage_breakdown().
  [summary] session=N ...   (cumulative counters for the whole process, so per-run metrics
                            are computed from the chunk lines, not from this line)
"""
from __future__ import annotations

import json
import re
import statistics
from collections import Counter, OrderedDict
from datetime import datetime
from pathlib import Path

RE_LINE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (DEBUG|INFO|WARN|ERROR) (.*)$")
RE_COMMIT = re.compile(
    r"\[chunk (\d+)\] COMMIT reason=(\S+) mode=(\S+) words=(\d+) (?:merged=(\d+) )?result=(\S+) "
    r"audio=([\d.]+)-([\d.]+)s commitLagMs=(-?\d+) queueDepth=(\d+) en=\"(.*)\"$")
RE_SYNTH = re.compile(
    r"\[chunk (?P<n>\d+)\] SYNTH translateMs=(?P<tr>\d+) synthMs=(?P<sy>\d+) (?:level=(?P<level>\d+) )?"
    r"rate=(?P<rate>\d+) backlogMs=(?P<backlog>-?\d+) .*?"
    r"audioMs=(?P<audio>\d+) ja=\"(?P<ja>.*?)\"(?= fillers=| \[corrected|$)")
RE_SINKQ = re.compile(r" sinkQueuedMs=(-?\d+)")
RE_SPEEDWHY = re.compile(r" speedWhy=(\S+)")
RE_SIGNAL = re.compile(r" signalMs=(-?\d+)")
RE_PLAYED = re.compile(
    r"\[chunk (\d+)\] PLAYED writtenBytes=(\d+) pcmBytes=(\d+) waitMs=(-?\d+) backlogMs=(-?\d+) "
    r"e2eFirstWordMs=(-?\d+) e2eLastWordMs=(-?\d+)")
RE_DROPPED = re.compile(r"\[chunk (\d+)\] DROPPED reason=(\S+) backlogMs=(-?\d+)")
RE_SKIPPED = re.compile(r"\[chunk (\d+)\] SKIPPED reason=(\S+)")
RE_FAILED = re.compile(r"\[chunk (\d+)\] FAILED stage=(\S+)")
RE_SESSION_START = re.compile(r"\[session (\d+)\] first audio received")
RE_SUMMARY = re.compile(r"\[summary\] (session=\d+|exit)")
RE_ENGINE = re.compile(r" engine=(\S+)")
RE_FBREASON = re.compile(r" fallbackReason=(\S+)")
RE_LLM_INT = {k: re.compile(rf" {k}=(-?\d+)") for k in ("llmMs", "inTok", "outTok", "cacheRead", "cacheWrite")}
RE_LLM_FALLBACK = re.compile(r"\[chunk \d+\] LLM_FALLBACK reason=(\S+)")
RE_LLM_REJECT = re.compile(r"\[chunk \d+\] LLM_REJECT rule=(\S+)")
RE_BREAKER_OPEN = re.compile(r"\[llm\] BREAKER open\b")
RE_LLM_SUMMARY = re.compile(r"\[llm-summary\] (session=\d+|exit) (.*)$")
RE_KV = re.compile(r"(\w+)=(.*?)(?= \w+=|$)")
# Language filter (LANGUAGE_FILTER=langid): a Transcribe result dropped before the segmenter.
RE_LANGDROP = re.compile(
    r"\[langfilter\] dropped result=(\S+) reason=(\S+) lang=(\S+) words=(\d+) conf=(\S+) "
    r"audio=([\d.]+)-([\d.]+)s lagMs=(-?\d+) text=\"(.*)\"$")
RE_VERIFY = re.compile(r"\[verify\] result=\S+ .*?\b(OK|MISMATCH|LANGDROP)\b")

STARTUP_PREFIXES = ("Simultaneous translation app starting", "  region=", "  segmentation ", "  playback ",
                    "  fillers ", "  langfilter ", "  translate ", "  llm ")

JA_CHARS = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]")
ROMAJI = {
    "desu", "desune", "deshita", "masu", "mashita", "masen", "arigato", "arigatou", "gozaimasu",
    "gozaimashita", "onegai", "onegaishimasu", "sumimasen", "konnichiwa", "hajimemashite", "yoroshiku",
    "kudasai", "nihon", "nihongo", "soudesu", "sodesu", "sorede", "dewa", "eto", "etto", "ano", "anoo",
    "hai", "sou", "kore", "sore", "nani", "nandesuka", "watashi", "minasan", "shitsumon", "dozo", "doumo",
}
# Common English function words. Real English chunks almost always contain several; the
# gibberish Transcribe (en-US) produces from Japanese speech often contains few.
FUNCTION_WORDS = set("""
a an the and or but so if then than that this these those there here it its it's is are was were be been
being am do does did doing have has had having i i'm you you're we we're they they're he she him her them
us our your their my me of to in on at for with from by about as into over under up down out off not no
yes can could will would should may might must just also very really what which who whom whose when where
why how all any some more most other such only own same too s t don't can't won't let's okay ok well now
one two lot like get got go going make made want need know think see because
""".split())

LANGSCAN_DIRNAME = "langscan"


def _utc_ms(iso: str) -> int:
    # strptime gives a naive datetime; interpret it as UTC.
    from datetime import timezone
    fmt = "%Y-%m-%dT%H:%M:%S.%fZ" if "." in iso else "%Y-%m-%dT%H:%M:%SZ"
    return int(datetime.strptime(iso, fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)


def parse_startup(lines: list[str]) -> "OrderedDict[str, str]":
    """Settings from the startup lines ("  region=...", "  segmentation ...", "  playback ...", "  fillers ...")."""
    cfg: "OrderedDict[str, str]" = OrderedDict()
    for raw in lines:
        m = RE_LINE.match(raw)
        msg = m.group(3) if m else raw
        if not msg.startswith(STARTUP_PREFIXES[1:]):
            continue
        body = msg.strip()
        if body.startswith("region="):
            group, rest = "", body
        else:
            group, _, rest = body.partition(" ")
        for k, v in RE_KV.findall(rest):
            cfg[f"{group}.{k}" if group else k] = v
    return cfg


def english_flags(en: str) -> list[str]:
    flags = []
    if JA_CHARS.search(en):
        flags.append("ja-chars")
    toks = re.findall(r"[a-z']+", en.lower())
    if any(t in ROMAJI for t in toks):
        flags.append("romaji")
    if len(toks) >= 6:
        ratio = sum(1 for t in toks if t in FUNCTION_WORDS) / len(toks)
        if ratio < 0.15:
            flags.append("low-english")
    return flags


def load_langscan(runs_dir: Path, file_stem: str) -> list[dict]:
    """ja-JP / en-US results from `e2e.sh langscan` (absolute file times)."""
    out: list[dict] = []
    d = runs_dir / LANGSCAN_DIRNAME
    if not d.is_dir():
        return out
    for p in sorted(d.glob(f"{file_stem}*.jsonl")):
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def ja_ranges(entries: list[dict], merge_gap: float = 8.0) -> list[dict]:
    """Merge consecutive ja-JP results (absolute file seconds) into ranges."""
    ja = sorted((e for e in entries if e.get("lang") == "ja-JP"), key=lambda e: e["start"])
    ranges: list[dict] = []
    for e in ja:
        if ranges and e["start"] - ranges[-1]["end"] <= merge_gap:
            r = ranges[-1]
            r["end"] = max(r["end"], e["end"])
            r["n"] += 1
            r["text"].append(e.get("text", ""))
        else:
            ranges.append({"start": e["start"], "end": e["end"], "n": 1, "text": [e.get("text", "")]})
    return ranges


def parse_log(lines: list[str]) -> dict:
    chunks: "OrderedDict[int, dict]" = OrderedDict()
    sessions = []
    errors = []
    drops: list[dict] = []
    verify: Counter = Counter()
    langfilter_seen = False
    summary_seen = False
    llm_summary: dict | None = None
    llm_fallback_lines: Counter = Counter()
    llm_reject_lines: Counter = Counter()
    breaker_opened = 0
    for raw in lines:
        m = RE_LINE.match(raw)
        if not m:
            continue
        iso, level, msg = m.groups()
        t = _utc_ms(iso)
        if level == "ERROR" or "RtcError" in msg or "unhandledRejection" in msg:
            errors.append(raw[:300])
        if mm := RE_SESSION_START.search(msg):
            sessions.append({"session": int(mm.group(1)), "ts": t})
            continue
        if mm := RE_LLM_SUMMARY.search(msg):
            llm_summary = dict(RE_KV.findall(mm.group(2)))
            llm_summary["label"] = mm.group(1)
            continue
        if mm := RE_LLM_FALLBACK.search(msg):
            llm_fallback_lines[mm.group(1)] += 1
            continue
        if mm := RE_LLM_REJECT.search(msg):
            llm_reject_lines[mm.group(1)] += 1
            continue
        if RE_BREAKER_OPEN.search(msg):
            breaker_opened += 1
            continue
        if RE_SUMMARY.search(msg):
            summary_seen = True
            continue
        if msg.startswith("[langfilter]"):
            langfilter_seen = True
        if mm := RE_LANGDROP.search(msg):
            a0, a1, lag = float(mm.group(6)), float(mm.group(7)), int(mm.group(8))
            conf = mm.group(5)
            drops.append(dict(result=mm.group(1), reason=mm.group(2), lang=mm.group(3), words=int(mm.group(4)),
                              conf=None if conf == "-" else float(conf), a0=a0, a1=a1, ts=t, lagMs=lag,
                              t0=t - lag - a1 * 1000, text=mm.group(9)))
            continue
        if mm := RE_VERIFY.search(msg):
            verify[mm.group(1)] += 1
            continue
        if mm := RE_COMMIT.search(msg):
            n = int(mm.group(1))
            a0, a1 = float(mm.group(7)), float(mm.group(8))
            lag = int(mm.group(9))
            chunks[n] = dict(n=n, reason=mm.group(2), words=int(mm.group(4)), merged=int(mm.group(5) or 0),
                             a0=a0, a1=a1, commitTs=t, commitLagMs=lag, en=mm.group(11),
                             t0=t - lag - a1 * 1000, status="queued", ja="", rate=None, level=None,
                             speedWhy=None, signalMs=None, e2e=None,
                             e2eLast=None, pcmBytes=None, backlogMs=None, audioMs=None,
                             translateMs=None, synthMs=None, sinkQueuedMs=None, waitMs=None, engine=None, fallbackReason=None, llmMs=None, inTok=None,
                             outTok=None, cacheRead=None, cacheWrite=None)
            continue
        if mm := RE_SYNTH.search(msg):
            c = chunks.get(int(mm.group("n")))
            if c:
                pre = msg[:mm.start("ja")]  # speed fields come before ja="..."
                why = RE_SPEEDWHY.search(pre)
                sig = RE_SIGNAL.search(pre)
                c.update(rate=int(mm.group("rate")), backlogMs=int(mm.group("backlog")), audioMs=int(mm.group("audio")),
                         ja=mm.group("ja"), status="synth",
                         level=int(mm.group("level")) if mm.group("level") else None,
                         speedWhy=why.group(1) if why else None, signalMs=int(sig.group(1)) if sig else None,
                         translateMs=int(mm.group("tr")), synthMs=int(mm.group("sy")))
                sq = RE_SINKQ.search(pre)
                c["sinkQueuedMs"] = int(sq.group(1)) if sq else None
                eng = RE_ENGINE.search(pre)
                fb = RE_FBREASON.search(pre)
                c.update(engine=eng.group(1) if eng else None, fallbackReason=fb.group(1) if fb else None)
                for k, rx in RE_LLM_INT.items():
                    v = rx.search(pre)
                    c[k] = int(v.group(1)) if v else None
            continue
        if mm := RE_PLAYED.search(msg):
            c = chunks.get(int(mm.group(1)))
            if c:
                c.update(status="played", pcmBytes=int(mm.group(2)), waitMs=int(mm.group(4)), e2e=int(mm.group(6)),
                         e2eLast=int(mm.group(7)), playedTs=t)
            continue
        if mm := RE_DROPPED.search(msg):
            c = chunks.get(int(mm.group(1)))
            if c:
                c.update(status="dropped", backlogMs=int(mm.group(3)))
            continue
        if mm := RE_SKIPPED.search(msg):
            c = chunks.get(int(mm.group(1)))
            if c:
                c.update(status="skipped:" + mm.group(2))
            continue
        if mm := RE_FAILED.search(msg):
            c = chunks.get(int(mm.group(1)))
            if c:
                c.update(status="failed:" + mm.group(2))
            continue
    _assign_timeline(chunks, drops)
    return dict(chunks=chunks, sessions=sessions, errors=errors, summarySeen=summary_seen, drops=drops,
                verify=dict(verify), langfilterSeen=langfilter_seen, llmSummary=llm_summary,
                llmFallbackLines=dict(llm_fallback_lines), llmRejectLines=dict(llm_reject_lines),
                breakerOpened=breaker_opened)


def _assign_timeline(chunks: "OrderedDict[int, dict]", drops: list[dict] | None = None) -> None:
    """Map each chunk (and each language-filter drop) to session time (s since the first audio of the session).

    chunk.t0 = wall ms of Transcribe stream time 0 (= commit log ts - commitLagMs - audioEnd).
    t0 only moves earlier within one Transcribe stream (it is a running minimum) and jumps
    later when Transcribe is reopened, so chunks are grouped into attempts at upward jumps.
    A drop's t0 (same arithmetic, from its lagMs) is snapped to the attempt whose t0 is within
    2 s; otherwise its own t0 is used. Chunk times do not depend on drops.
    """
    drops = drops or []
    attempts: list[list[dict]] = []
    cur_min = None
    for c in chunks.values():
        if cur_min is None or c["t0"] - cur_min > 2000:
            attempts.append([])  # first chunk, or Transcribe was reopened
            cur_min = c["t0"]
        else:
            cur_min = min(cur_min, c["t0"])
        attempts[-1].append(c)
    if not attempts and not drops:
        return
    group_t0 = [min(c["t0"] for c in g) for g in attempts]
    anchor = group_t0[0] if attempts else min(d["t0"] for d in drops)
    for d in drops:
        near = [g0 for g0 in group_t0 if abs(d["t0"] - g0) <= 2000]
        t0 = min(near, key=lambda g0: abs(d["t0"] - g0)) if near else d["t0"]
        d["rel0"] = (t0 - anchor) / 1000 + d["a0"]
        d["rel1"] = (t0 - anchor) / 1000 + d["a1"]
    for group in attempts:
        g0 = min(c["t0"] for c in group)
        for c in group:
            c["rel0"] = (g0 - anchor) / 1000 + c["a0"]
            c["rel1"] = (g0 - anchor) / 1000 + c["a1"]
            if c.get("e2e") is not None:
                # Same arithmetic as ChunkPlayer: heardAt = t0 + audioStart + e2eFirstWordMs.
                c["heardRel"] = (c["t0"] + c["a0"] * 1000 + c["e2e"] - anchor) / 1000
    for c in chunks.values():
        c["anchorMs"] = anchor


def fmt_hms(sec: float) -> str:
    sec = max(0.0, sec)
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


def pct(vals: list[float], p: int) -> int | None:
    if not vals:
        return None
    v = sorted(vals)
    k = max(1, -(-len(v) * p // 100))
    return int(v[int(k) - 1])


SPEED_GLYPHS = "▁▂▃▄▅▆▇█"


def speed_glyph(rate: int) -> str:
    """Block glyph for a Polly rate on a fixed 100-150% scale (same for every run)."""
    return SPEED_GLYPHS[max(0, min(7, round((rate - 100) / 50 * 7)))]


def speed_series(parsed: dict) -> list[dict]:
    """Synthesized chunks (have a rate) in chunk order."""
    return [c for c in parsed["chunks"].values() if c.get("rate") is not None]


def _changes(vals: list[int]) -> tuple[int, int]:
    """(number of changes, max absolute jump) between consecutive values."""
    n = jump = 0
    for a, b in zip(vals, vals[1:]):
        if a != b:
            n += 1
            jump = max(jump, abs(b - a))
    return n, jump


def speed_cell(c: dict, prev: dict | None) -> str:
    """Chunk-table "Speed timeline" cell: glyph, level, direction vs the previous synthesized chunk, ! = urgent."""
    if c.get("rate") is None:
        return ""
    out = speed_glyph(c["rate"])
    if c.get("level") is not None:
        out += f" L{c['level']}"
    if prev is not None:
        key = "level" if c.get("level") is not None and prev.get("level") is not None else "rate"
        if c[key] > prev[key]:
            out += "↑"
        elif c[key] < prev[key]:
            out += "↓"
    if c.get("speedWhy") == "urgent":
        out += "!"
    return out


def speed_timeline_lines(parsed: dict) -> list[str]:
    """One line per source minute: glyphs, then levels (or rates on old logs)."""
    by_min: "OrderedDict[int, list[dict]]" = OrderedDict()
    for c in speed_series(parsed):
        by_min.setdefault(int(c.get("src0", c["a0"]) // 60), []).append(c)
    out = []
    for mnt, cs in by_min.items():
        glyphs = "".join(speed_glyph(c["rate"]) for c in cs)
        if all(c.get("level") is not None for c in cs):
            vals = " ".join(f"L{c['level']}" + ("!" if c.get("speedWhy") == "urgent" else "") for c in cs)
        else:
            vals = " ".join(str(c["rate"]) for c in cs)
        out.append(f"{mnt:02d}:00  {glyphs}  ({vals})")
    return out


# ---------------------------------------------------------------- fragmentation (quality v1)
# Mirrors segmenter.ts DEFAULT_DANGLING_WORDS (and probe/frag.py): a chunk ending on one of these without .?! is split mid-phrase.
DANGLING_WORDS = frozenset("""in on at to of for with within from into by about as than over under between through across during before after against among around
a an the this these those each every my your our their its his her some any no
who which that where when whose while if because although though unless since whether
and or but so nor yet
is are was were am be been being can could will would shall should may might must do does did have has had
's""".split())
FRAG_FILLER = re.compile(r"\b(uh|um|er|ah|hmm)\b[,]?\s*", re.I)
FRAG_WORD = re.compile(r"[A-Za-z0-9'’-]+")
FRAG_END = re.compile(r'[.?!]["”]?$')

# Chunk starts the user listed as wrongly split (an evidence run).
USER_CHUNK_TAILS = ["you're used to.", "different layouts.", "MediaLive.", "multi-view experiences.", "used to.", "pull",
                    "that MediaPackage channel group.", "different videos.", "that channel.", "to access.",
                    "curated formats."]


def _frag_clean(en: str) -> str:
    return FRAG_FILLER.sub("", en).strip()


def fragmentation(chunks: list[dict]) -> dict:
    """Chunk-split quality: dangling ends, continuation starts, tiny chunks. chunks = parsed chunks in order.

    dangling = last word is in DANGLING_WORDS and the text has no .?! end; continuation = starts lowercase while
    the previous chunk has no .?! end; short = at most 3 words. Offenders are (chunk, reason, en, ja).
    """
    dang: list[dict] = []
    cont: list[dict] = []
    short: list[dict] = []
    prev = "."
    for c in chunks:
        en = _frag_clean(c["en"])
        words = FRAG_WORD.findall(en)
        row = dict(n=c["n"], en=c["en"], ja=c.get("ja", ""))
        if words and words[-1].lower() in DANGLING_WORDS and not FRAG_END.search(en):
            dang.append(dict(row, reason="dangling-end"))
        if re.match(r"^[a-z]", en) and not FRAG_END.search(prev):
            cont.append(dict(row, reason="continuation"))
        if len(words) <= 3:
            short.append(dict(row, reason="<=3 words"))
        prev = en
    return dict(dangling=dang, continuation=cont, short=short)


def _norm_tail(t: str) -> str:
    return " ".join(re.findall(r"[a-z0-9'’-]+", _frag_clean(t).lower()))


def user_chunk_regression(chunks: list[dict], tails: list[str] | None = None) -> list[dict]:
    """For each listed tail: `separate` = a chunk starts with that text (the split is still there), `merged` = the
    text occurs only inside a chunk, `absent` = not found in the run."""
    norm = [(c["n"], _norm_tail(c["en"])) for c in chunks]
    out = []
    for tail in tails or USER_CHUNK_TAILS:
        t = _norm_tail(tail)
        pat = re.compile(r"(^| )" + re.escape(t) + r"( |$)")
        starts = [n for n, e in norm if e == t or e.startswith(t + " ")]
        inside = [n for n, e in norm if pat.search(e)]
        if starts:
            out.append(dict(tail=tail, state="separate", chunks=starts))
        elif inside:
            out.append(dict(tail=tail, state="merged", chunks=inside))
        else:
            out.append(dict(tail=tail, state="absent", chunks=[]))
    return out


def fragmentation_lines(chunks: list[dict]) -> list[str]:
    fr = fragmentation(chunks)
    L = ["| Class | Chunks |", "|---|---|"]
    L.append(f"| Dangling end (ends on a preposition/article/relative word without .?!) | {len(fr['dangling'])} |")
    L.append(f"| Continuation (lowercase start after a chunk without .?!) | {len(fr['continuation'])} |")
    L.append(f"| Tiny chunks (<= 3 words) | {len(fr['short'])} |")
    L.append("")
    for key, title in (("dangling", "Dangling ends"), ("continuation", "Continuations"), ("short", "Chunks of 3 words or fewer")):
        rows = fr[key]
        if not rows:
            continue
        L.append(f"{title}:")
        L.append("")
        L.append("| # | Reason | EN | JA |")
        L.append("|---|---|---|---|")
        for r in rows:
            L.append(f"| {r['n']} | {r['reason']} | {_md(r['en'])} | {_md(r['ja'])} |")
        L.append("")
    reg = user_chunk_regression(chunks)
    if any(r["state"] != "absent" for r in reg):
        L.append("Listed split chunks (evidence run): `separate` = still its own chunk, `merged` = joined to the text before it, "
                 "`absent` = not in this clip.")
        L.append("")
        L.append("| Text | State | Chunk(s) |")
        L.append("|---|---|---|")
        for r in reg:
            L.append(f"| {_md(r['tail'])} | {r['state']} | {', '.join(str(n) for n in r['chunks']) or '-'} |")
        L.append("")
    return L


# Haiku 4.5 list prices, USD per 1M tokens (same formula as the app's [llm-summary] estUsd).
LLM_PRICE_IN, LLM_PRICE_OUT, LLM_PRICE_CACHE_READ, LLM_PRICE_CACHE_WRITE = 1.0, 5.0, 0.1, 1.25


def _stats(vals: list[float]) -> tuple:
    """(avg, p50, p90, max) as ints, or four Nones."""
    if not vals:
        return None, None, None, None
    return int(statistics.mean(vals)), pct(vals, 50), pct(vals, 90), int(max(vals))


def has_llm_fields(chunks: list[dict]) -> bool:
    return any(c.get("engine") for c in chunks)


def llm_metrics(parsed: dict, ch: list[dict]) -> dict:
    """LLM-engine metrics; only called when at least one SYNTH line has engine=. Per-run numbers come from the
    chunk lines; the [llm-summary] line is process-cumulative (includes warm-up/keep-warm) and kept as-is."""
    split = Counter(c["engine"] for c in ch if c.get("engine"))
    llm_ms = [c["llmMs"] for c in ch if c.get("llmMs") is not None]
    tr_ms = [c["translateMs"] for c in ch if c.get("engine") == "translate" and c.get("translateMs") is not None]
    fb = Counter(c.get("fallbackReason") or "unknown" for c in ch if c.get("engine") == "fallback")

    def total(key):
        return sum(c[key] or 0 for c in ch if c.get(key) is not None)
    in_tok, out_tok, c_read, c_write = total("inTok"), total("outTok"), total("cacheRead"), total("cacheWrite")
    denom = in_tok + c_read + c_write
    cost = (in_tok * LLM_PRICE_IN + out_tok * LLM_PRICE_OUT + c_read * LLM_PRICE_CACHE_READ
            + c_write * LLM_PRICE_CACHE_WRITE) / 1e6
    l_avg, l_p50, l_p90, l_max = _stats(llm_ms)
    t_avg, t_p50, t_p90, _ = _stats(tr_ms)
    return dict(
        engineSplit={k: split.get(k, 0) for k in ("llm", "translate", "fallback")},
        llmMsAvg=l_avg, llmMsP50=l_p50, llmMsP90=l_p90, llmMsMax=l_max,
        translateMsAvg=t_avg, translateMsP50=t_p50, translateMsP90=t_p90,
        fallbackByReason=dict(fb.most_common()),
        llmFallbackLines=sum(parsed.get("llmFallbackLines", {}).values()),
        llmRejectLines=sum(parsed.get("llmRejectLines", {}).values()),
        breakerOpened=parsed.get("breakerOpened", 0),
        cacheHitRate=round(c_read / denom, 4) if denom else None,
        llmInTok=in_tok, llmOutTok=out_tok, llmCacheRead=c_read, llmCacheWrite=c_write,
        estUsd=round(cost, 4),
        llmSummary=parsed.get("llmSummary"),
    )


def metrics(parsed: dict, clip_sec: float | None = None) -> dict:
    ch = list(parsed["chunks"].values())
    series = speed_series(parsed)
    levels = [c["level"] for c in series if c.get("level") is not None]
    have_levels = bool(series) and len(levels) == len(series)
    level_changes, max_level_jump = _changes(levels) if have_levels else (None, None)
    rate_changes, max_rate_jump = _changes([c["rate"] for c in series])
    minutes = (clip_sec / 60) if clip_sec else None
    per_min = (lambda n: round(n / minutes, 2) if (minutes and n is not None) else None)
    whys = Counter(c["speedWhy"] for c in series if c.get("speedWhy"))
    e2e = [c["e2e"] for c in ch if c["e2e"] is not None]
    e2e_last = [c["e2eLast"] for c in ch if c["e2eLast"] is not None]
    commit_lag = [c["commitLagMs"] for c in ch]
    backlog = [c["backlogMs"] for c in ch if c["backlogMs"] is not None]
    rates = Counter(c["rate"] for c in ch if c["rate"] is not None)
    status = Counter(c["status"].split(":")[0] for c in ch)
    flagged = [c for c in ch if c.get("flags")]
    drops = parsed.get("drops", [])
    verify = parsed.get("verify", {})
    frag = fragmentation(ch)
    out = dict(
        chunks=len(ch),
        fragDangling=len(frag["dangling"]), fragContinuation=len(frag["continuation"]), fragShort=len(frag["short"]),
        reasons=dict(Counter(c["reason"] for c in ch).most_common()),
        played=status.get("played", 0), dropped=status.get("dropped", 0), skipped=status.get("skipped", 0),
        failed=status.get("failed", 0), unfinished=status.get("queued", 0) + status.get("synth", 0),
        avgE2eFirstWordMs=int(statistics.mean(e2e)) if e2e else None,
        p50E2eFirstWordMs=pct(e2e, 50), p90E2eFirstWordMs=pct(e2e, 90), maxE2eFirstWordMs=max(e2e) if e2e else None,
        avgE2eLastWordMs=int(statistics.mean(e2e_last)) if e2e_last else None,
        p50E2eLastWordMs=pct(e2e_last, 50), p90E2eLastWordMs=pct(e2e_last, 90),
        maxE2eLastWordMs=max(e2e_last) if e2e_last else None,
        avgCommitLagMs=int(statistics.mean(commit_lag)) if commit_lag else None, p90CommitLagMs=pct(commit_lag, 90),
        maxBacklogMs=max(backlog) if backlog else None,
        rateHistogram={str(k): v for k, v in sorted(rates.items())},
        levelHistogram={f"L{k}": v for k, v in sorted(Counter(levels).items())} if have_levels else {},
        levelChanges=level_changes, maxLevelJump=max_level_jump, levelChangesPerMin=per_min(level_changes),
        rateChanges=rate_changes, maxRateJump=max_rate_jump, rateChangesPerMin=per_min(rate_changes),
        speedWhy=dict(whys.most_common()),
        medianWords=statistics.median([c["words"] for c in ch]) if ch else None,
        jaAudioSec=round(sum((c["audioMs"] or 0) for c in ch if c["status"] == "played") / 1000, 1),
        flaggedNonEnglish=len(flagged),
        errors=len(parsed["errors"]),
        langDropped=len(drops),
        langDroppedWords=sum(d["words"] for d in drops),
        langDroppedJa=sum(1 for d in drops if d.get("langscanJa")),
        langDroppedSuspect=sum(1 for d in drops if d.get("langscanJa") is False),
        langscanJaPlayed=sum(1 for c in ch if c["status"] == "played" and "langscan-ja" in (c.get("flags") or [])),
        verifyOk=verify.get("OK", 0), verifyMismatch=verify.get("MISMATCH", 0), verifyLangdrop=verify.get("LANGDROP", 0),
        verify=f"{verify.get('OK', 0)} / {verify.get('MISMATCH', 0)} / {verify.get('LANGDROP', 0)}",
    )
    out.update(sentence_start_metrics(ch))
    if has_llm_fields(ch):
        out.update(llm_metrics(parsed, ch))
    return out


# ---------------------------------------------------------------- sentence start lag
STAGE_KEYS = ("span", "commitLag", "workerWait", "translate", "synth", "sinkWait", "total")


def sentence_starts(chunks: list[dict]) -> list[dict]:
    """Chunks that open a sentence: the first chunk of the log, or the first after a chunk whose English ends in
    .?! (optionally followed by a closing quote). `chunks` = parsed chunks in commit order; skipped and failed
    chunks still count as the "previous chunk" so a sentence start is not invented after a filler-only chunk."""
    out = []
    prev_end = True
    for c in chunks:
        if prev_end:
            out.append(c)
        prev_end = bool(FRAG_END.search(c["en"].strip()))
    return out


def stage_breakdown(c: dict) -> dict | None:
    """Split e2eFirstWordMs of one played chunk into stages (ms), or None when a field is missing.
    span       first English word to last English word of the chunk (the chunk has to be spoken first)
    commitLag  last English word to COMMIT (Transcribe stabilization, language-ID settle, holds)
    workerWait COMMIT to the start of translation (queue behind the earlier chunks' translate + synth)
    translate  translateMs (Amazon Translate or LLM call)
    synth      synthMs (Polly)
    sinkWait   Japanese audio of earlier chunks still playing when this one is pushed
    Identity: heardAt - committedAt = workerWait + translate + synth + waitMs + sinkWait. sinkQueuedMs is logged
    after translation, so sinkWait is estimated as max(0, sinkQueuedMs - synthMs) (the sink drains in real time);
    waitMs (push blocked after synth, normally 0) is added to sinkWait. workerWait is the remainder.
    """
    need = ("e2e", "e2eLast", "translateMs", "synthMs", "sinkQueuedMs", "waitMs")
    if any(c.get(k) is None for k in need):
        return None
    span = (c["a1"] - c["a0"]) * 1000
    after_commit = c["e2eLast"] - c["commitLagMs"]
    sink = max(0, c["sinkQueuedMs"] - c["synthMs"])
    sink_total = min(sink + max(0, c["waitMs"]), max(0, after_commit - c["translateMs"] - c["synthMs"]))
    worker = max(0, after_commit - c["translateMs"] - c["synthMs"] - sink_total)
    return dict(span=span, commitLag=c["commitLagMs"], workerWait=worker, translate=c["translateMs"],
                synth=c["synthMs"], sinkWait=sink_total, total=c["e2e"])


def _mean_stages(rows: list[dict]) -> dict:
    return {k: int(statistics.mean(r[k] for r in rows)) for k in STAGE_KEYS} if rows else {}


def sentence_start_metrics(ch: list[dict]) -> dict:
    """sentenceStartLagMs = e2eFirstWordMs of the chunks that open a sentence (what the listener perceives at the
    start of each sentence), plus the mean stage split for sentence starts and for the other chunks."""
    starts = sentence_starts(ch)
    start_ids = {c["n"] for c in starts}
    lag = [c["e2e"] for c in starts if c.get("e2e") is not None]
    st_rows = [b for c in starts if (b := stage_breakdown(c))]
    ot_rows = [b for c in ch if c["n"] not in start_ids and (b := stage_breakdown(c))]
    return dict(
        sentenceStartCount=len(lag),
        sentenceStartLagAvgMs=int(statistics.mean(lag)) if lag else None,
        sentenceStartLagP50Ms=int(statistics.median(lag)) if lag else None,
        sentenceStartLagP90Ms=pct(lag, 90), sentenceStartLagMaxMs=int(max(lag)) if lag else None,
        stagesSentenceStart=_mean_stages(st_rows), stagesOther=_mean_stages(ot_rows),
        stageCountSentenceStart=len(st_rows), stageCountOther=len(ot_rows),
    )


def sentence_start_lines(m: dict) -> list[str]:
    L = ["## Sentence start lag", "",
         "sentenceStartLagMs = e2eFirstWordMs of the first chunk of each sentence (first chunk of the run, or the first "
         "chunk after one whose English ends in . ? !): first English word of the sentence to first Japanese sound. "
         "Stage means split e2eFirstWordMs: span = first to last English word of the chunk, commitLag = last word to "
         "COMMIT, workerWait = COMMIT to start of translation, translate, synth (Polly), sinkWait = earlier Japanese "
         "audio still playing (sinkWait is estimated from sinkQueuedMs; see `stage_breakdown` in report.py).", "",
         "| Metric | Value |", "|---|---|"]
    L.append(f"| sentenceStartLagMs avg / median / p90 / max (count) | {_fmt(m['sentenceStartLagAvgMs'])} / "
             f"{_fmt(m['sentenceStartLagP50Ms'])} / {_fmt(m['sentenceStartLagP90Ms'])} / "
             f"{_fmt(m['sentenceStartLagMaxMs'])} ({m['sentenceStartCount']}) |")
    L.append("")
    a, b = m["stagesSentenceStart"], m["stagesOther"]
    if a or b:
        L.append("| Mean ms per stage | span | commitLag | workerWait | translate | synth | sinkWait | = e2eFirstWordMs | chunks |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        for title, st, n in (("Sentence-start chunks", a, m["stageCountSentenceStart"]),
                             ("Other chunks", b, m["stageCountOther"])):
            if st:
                L.append(f"| {title} | {st['span']} | {st['commitLag']} | {st['workerWait']} | {st['translate']} | "
                         f"{st['synth']} | {st['sinkWait']} | {st['total']} | {n} |")
        L.append("")
    return L


def _md(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


def _language_filter_section(parsed: dict, m: dict, have_scan: bool) -> list[str]:
    """"## Language filter": Transcribe results the app dropped as non-English (LANGUAGE_FILTER=langid)."""
    L = ["## Language filter", ""]
    drops = parsed.get("drops", [])
    if not parsed.get("langfilterSeen") and not drops:
        L.append("(no language-filter lines (filter off or older build))")
        L.append("")
        L.append(f"`[verify]` OK / MISMATCH / LANGDROP: {m['verifyOk']} / {m['verifyMismatch']} / {m['verifyLangdrop']}")
        L.append("")
        return L
    L.append("Transcribe results dropped before translation (`[langfilter] dropped`). A drop that overlaps a "
             "`langscan` ja-JP range (±0.5 s) is a correct drop; a drop with no overlap is a suspected false drop "
             "of English: listen to `source-clip.wav` at that time.")
    L.append("")
    reasons = Counter(d["reason"] for d in drops)
    L.append("| Metric | Value |")
    L.append("|---|---|")
    L.append(f"| Dropped results | {len(drops)} ({', '.join(f'{k}={v}' for k, v in reasons.most_common()) or '-'}) |")
    L.append(f"| Dropped words | {m['langDroppedWords']} |")
    if have_scan:
        unknown = sum(1 for d in drops if d.get("langscanJa") is None)
        L.append(f"| Correct drops (overlap langscan-ja) | {m['langDroppedJa']} |")
        L.append(f"| Suspected false drops of English (no langscan-ja overlap) | {m['langDroppedSuspect']} |")
        if unknown:
            L.append(f"| Drops beyond the language scan coverage | {unknown} |")
    else:
        L.append("| Correct / suspected false drops | no language-scan data (run `e2e.sh langscan`) |")
    L.append(f"| Played chunks overlapping langscan-ja | {m['langscanJaPlayed']} |")
    L.append(f"| `[verify]` OK / MISMATCH / LANGDROP | {m['verifyOk']} / {m['verifyMismatch']} / {m['verifyLangdrop']} |")
    L.append("")
    if drops:
        order = {False: 0, None: 1, True: 2}  # suspected false drops first
        L.append("| Source time | Reason | Lang | Words | Conf | langscan-ja | Text (Transcribe) |")
        L.append("|---|---|---|---|---|---|---|")
        for d in sorted(drops, key=lambda d: (order[d.get("langscanJa")], d["src0"])):
            ls = {True: "yes", False: "**no**", None: "-"}[d.get("langscanJa")]
            conf = "-" if d["conf"] is None else f"{d['conf']:.2f}"
            L.append(f"| {fmt_hms(d['src0'])}–{fmt_hms(d['src1'])} | {d['reason']} | {d['lang']} | {d['words']} | "
                     f"{conf} | {ls} | {_md(d['text'])} |")
        L.append("")
    return L


def eng_cell(c: dict) -> str:
    eng = c.get("engine")
    if eng == "fallback":
        return f"fb:{c.get('fallbackReason') or '?'}"
    return eng or ""


def _llm_engine_section(m: dict, cfg: "OrderedDict[str, str]") -> list[str]:
    """"## LLM engine": only for logs whose SYNTH lines carry engine= (newer builds)."""
    sp = m["engineSplit"]
    L = ["## LLM engine", "",
         "Engine per chunk: `llm` = the LLM translated it, `translate` = Amazon Translate by configuration, "
         "`fallback` = the LLM failed or was skipped and Amazon Translate was used (`Eng` column: `fb:<reason>`). "
         "`translateMs` in the chunk lines is the whole translate stage, including a failed LLM attempt.", "",
         "| Metric | Value |", "|---|---|"]
    if cfg.get("llm.model"):
        L.append(f"| Model | `{_md(cfg['llm.model'])}` |")
    L.append(f"| Chunks llm / translate / fallback | {sp['llm']} / {sp['translate']} / {sp['fallback']} |")
    L.append(f"| llmMs avg / p50 / p90 / max (chunks with an LLM call) | {_fmt(m['llmMsAvg'])} / {_fmt(m['llmMsP50'])} / "
             f"{_fmt(m['llmMsP90'])} / {_fmt(m['llmMsMax'])} |")
    L.append(f"| translateMs avg / p50 / p90 (engine=translate chunks) | {_fmt(m['translateMsAvg'])} / "
             f"{_fmt(m['translateMsP50'])} / {_fmt(m['translateMsP90'])} |")
    L.append(f"| Fallbacks by reason | {_fmt(m['fallbackByReason'])} |")
    L.append(f"| LLM_FALLBACK / LLM_REJECT log lines | {m['llmFallbackLines']} / {m['llmRejectLines']} |")
    L.append(f"| Breaker opened | {m['breakerOpened']} |")
    L.append(f"| Cache hit rate (cacheRead / (inTok + cacheRead + cacheWrite)) | {_fmt(m['cacheHitRate'])} |")
    L.append(f"| Tokens in / out / cacheRead / cacheWrite (chunk calls) | {m['llmInTok']} / {m['llmOutTok']} / "
             f"{m['llmCacheRead']} / {m['llmCacheWrite']} |")
    L.append(f"| Estimated cost (chunk calls) | ${m['estUsd']:.4f} (Haiku 4.5 list price, jp. premium not included) |")
    s = m.get("llmSummary")
    if s:
        keep = ("used", "fallback", "skipBacklog", "breakerOpened", "meanLlmMs", "p90LlmMs", "maxLlmMs", "cacheHitRate",
                "translateCalls", "estUsd")
        L.append(f"| `[llm-summary]` {s.get('label', '')} (whole process, incl. warm-up/keep-warm calls) | "
                 + ", ".join(f"{k}={_md(s[k])}" for k in keep if k in s) + " |")
    L.append("")
    return L


JUDGE_START = "<!-- HUMAN-JUDGEMENT-START -->"
JUDGE_END = "<!-- HUMAN-JUDGEMENT-END -->"
JUDGE_TEMPLATE = f"""{JUDGE_START}
Fill this in after listening to `translation.wav` / `side-by-side.wav` (or live on the listener page).
Scores: 1 = unusable, 3 = acceptable, 5 = as good as a human interpreter.

| Criterion | Score (1-5) | Notes |
|---|---|---|
| Accuracy (meaning preserved) |  |  |
| Fluency (natural Japanese) |  |  |
| Latency (lag acceptable) |  |  |
| Naturalness of speed |  |  |
| Japanese speech ignored (no output for JA moderator/audience) |  |  |
| Overall |  |  |

Listener:
Date:
Notes:
{JUDGE_END}"""


def parse_judgement(text: str) -> dict:
    out = {}
    if JUDGE_START not in text:
        return out
    block = text.split(JUDGE_START, 1)[1].split(JUDGE_END, 1)[0]
    for line in block.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and re.fullmatch(r"[1-5](\.\d)?", cells[1] or ""):
            out[cells[0]] = cells[1]
    return out


def cloud_input(meta: dict) -> str:
    """Input of a cloud run. Runs recorded before --input existed were SRT."""
    return meta.get("input") or "srt"


def build_report(run_dir: Path, meta: dict, log_lines: list[str], startup_lines: list[str],
                 audio: dict, runs_dir: Path) -> tuple[str, dict]:
    parsed = parse_log(log_lines)
    clip_start = float(meta.get("clipStartSec", 0))
    stem = meta.get("fileStem", "")
    scan = load_langscan(runs_dir, stem) if stem else []
    ja_scan = [e for e in scan if e.get("lang") == "ja-JP"]
    for c in parsed["chunks"].values():
        c["src0"] = clip_start + c.get("rel0", c["a0"])
        c["src1"] = clip_start + c.get("rel1", c["a1"])
        flags = english_flags(c["en"])
        if any(e["start"] < c["src1"] + 0.5 and e["end"] > c["src0"] - 0.5 for e in ja_scan):
            flags.append("langscan-ja")
        c["flags"] = flags
    scan_covered = max((e["end"] for e in scan), default=None)
    for d in parsed["drops"]:
        d["src0"] = clip_start + d.get("rel0", d["a0"])
        d["src1"] = clip_start + d.get("rel1", d["a1"])
        if scan_covered is None or d["src0"] > scan_covered:
            d["langscanJa"] = None  # no language-scan data for this time
        else:
            d["langscanJa"] = any(e["start"] < d["src1"] + 0.5 and e["end"] > d["src0"] - 0.5 for e in ja_scan)
    m = metrics(parsed, float(meta.get("clipDurationSec", 0)) or None)
    cfg = parse_startup(startup_lines or log_lines)

    L = []
    L.append(f"# E2E run report: {meta.get('label', '')}")
    L.append("")
    L.append(f"- Mode: **{meta.get('mode')}**" + (f" (deployed system via {cloud_input(meta).upper()} + LiveKit)"
                                                  if meta.get("mode") == "cloud"
                                                  else " (app run locally with INPUT_FILE + file sink, real AWS AI services)"))
    L.append(f"- Recording: `{meta.get('file')}`")
    L.append(f"- Clip: start {fmt_hms(clip_start)} ({clip_start:.1f} s), duration {meta.get('clipDurationSec', 0):.1f} s")
    L.append(f"- Run started: {meta.get('startedAt')}  ·  folder `{run_dir.name}`")
    if meta.get("mode") == "cloud":
        L.append(f"- Input: **{cloud_input(meta)}**" + ("" if meta.get("input") else " (older run: assumed)"))
        if cloud_input(meta) == "rtmps":
            L.append(f"- RTMPS target: `{meta.get('rtmpsUrlRedacted')}` (stream key redacted)")
        else:
            L.append(f"- SRT target: `{meta.get('srtUrlRedacted')}` (passphrase redacted)")
        L.append(f"- ECS task def revision: {meta.get('taskDefRevision')}  ·  task `{meta.get('taskId')}`")
    if meta.get("configSource"):
        L.append(f"- Config source: {meta.get('configSource')}")
    if meta.get("note"):
        L.append(f"- Note: {meta['note']}")
    L.append("")
    L.append("Files: `translation.wav` (Japanese output, sample 0 = stream start), `source-clip.wav` (English input), "
             "`side-by-side.wav` (left = source, right = translation, time-aligned), `app.log`, `report.md`.")
    L.append("")

    L.append("## Settings in effect (from the app's startup log lines)")
    L.append("")
    if cfg:
        L.append("| Setting | Value |")
        L.append("|---|---|")
        for k, v in cfg.items():
            L.append(f"| {k} | `{_md(v)}` |")
    else:
        L.append("(startup lines not found)")
    if meta.get("envOverrides"):
        L.append("")
        L.append("Overrides passed with `--env`: " + ", ".join(f"`{k}={v}`" for k, v in meta["envOverrides"].items()))
    L.append("")

    L.append("## Summary")
    L.append("")
    L.append("| Metric | Value |")
    L.append("|---|---|")
    L.append(f"| Chunks committed | {m['chunks']} |")
    L.append(f"| COMMIT reasons | {', '.join(f'{k}={v}' for k, v in m['reasons'].items()) or '-'} |")
    L.append(f"| Played / dropped / skipped / failed | {m['played']} / {m['dropped']} / {m['skipped']} / {m['failed']}"
             + (f" (unfinished {m['unfinished']})" if m["unfinished"] else "") + " |")
    L.append(f"| e2eFirstWordMs avg / p50 / p90 / max | {m['avgE2eFirstWordMs']} / {m['p50E2eFirstWordMs']} / "
             f"{m['p90E2eFirstWordMs']} / {m['maxE2eFirstWordMs']} |")
    L.append(f"| sentenceStartLagMs avg / median / p90 (sentences) | {_fmt(m['sentenceStartLagAvgMs'])} / "
             f"{_fmt(m['sentenceStartLagP50Ms'])} / {_fmt(m['sentenceStartLagP90Ms'])} ({m['sentenceStartCount']}) |")
    L.append(f"| e2eLastWordMs avg | {m['avgE2eLastWordMs']} |")
    L.append(f"| e2eLastWordMs p50 / p90 / max | {m['p50E2eLastWordMs']} / {m['p90E2eLastWordMs']} / "
             f"{m['maxE2eLastWordMs']} |")
    L.append(f"| commitLagMs avg / p90 | {m['avgCommitLagMs']} / {m['p90CommitLagMs']} |")
    L.append(f"| maxBacklogMs (SYNTH/DROPPED) | {m['maxBacklogMs']} |")
    L.append(f"| Speed rate histogram (SYNTH rate=) | {', '.join(f'{k}%: {v}' for k, v in m['rateHistogram'].items()) or '-'} |")
    L.append(f"| Speed level histogram (SYNTH level=) | {', '.join(f'{k}: {v}' for k, v in m['levelHistogram'].items()) or '-'} |")
    L.append(f"| Level changes (per min) / max jump | " + (
        f"{m['levelChanges']} ({_fmt(m['levelChangesPerMin'])}/min) / {m['maxLevelJump']}" if m["levelChanges"] is not None
        else "-") + " |")
    L.append(f"| Rate changes (per min) / max jump (pts) | {m['rateChanges']} ({_fmt(m['rateChangesPerMin'])}/min) / "
             f"{m['maxRateJump']} |")
    L.append(f"| Speed decisions (speedWhy) | {', '.join(f'{k}={v}' for k, v in m['speedWhy'].items()) or '-'} |")
    L.append(f"| Median words per chunk | {m['medianWords']} |")
    L.append(f"| Fragmentation: dangling ends / continuations / <= 3 words | {m['fragDangling']} / {m['fragContinuation']} / {m['fragShort']} |")
    L.append(f"| Japanese audio played | {m['jaAudioSec']} s |")
    L.append(f"| Rows flagged as possibly non-English | {m['flaggedNonEnglish']} |")
    L.append(f"| ERROR / RtcError lines | {m['errors']} |")
    for k, v in audio.items():
        L.append(f"| {k} | {v} |")
    L.append("")
    if parsed["errors"]:
        L.append("Error lines (first 10):")
        L.append("")
        L.append("```")
        L.extend(parsed["errors"][:10])
        L.append("```")
        L.append("")

    L.extend(sentence_start_lines(m))

    show_llm = "engineSplit" in m
    if show_llm:
        L.extend(_llm_engine_section(m, cfg))

    L.append("## Fragmentation")
    L.append("")
    L.extend(fragmentation_lines(list(parsed["chunks"].values())))

    L.append("## Speed timeline")
    L.append("")
    L.append("One line per source minute (mm:00 = minute of the recording), one glyph per synthesized chunk on a fixed "
             "scale ▁ = 100% … █ = 150%; in brackets the level (Lx, ! = urgent jump), or the rate % for logs without levels.")
    L.append("")
    tl = speed_timeline_lines(parsed)
    if tl:
        L.append("```")
        L.extend(tl)
        L.append("```")
    else:
        L.append("(no synthesized chunks)")
    L.append("")

    L.append("## Possible Japanese / non-English speech")
    L.append("")
    L.append("Flags: `ja-chars` = Japanese characters in the English transcript; `romaji` = romanized Japanese "
             "words; `low-english` = few English function words (typical of Transcribe en-US output for Japanese "
             "speech); `langscan-ja` = overlaps a range that `e2e.sh langscan` (Transcribe language ID) labelled ja-JP. "
             "Heuristic flags can be false positives: confirm by listening to `source-clip.wav` at the given time.")
    L.append("")
    flagged = [c for c in parsed["chunks"].values() if c["flags"]]
    if flagged:
        L.append("| # | Source time | Flags | EN (Transcribe) | JA (spoken) | Status |")
        L.append("|---|---|---|---|---|---|")
        for c in flagged:
            L.append(f"| {c['n']} | {fmt_hms(c['src0'])}–{fmt_hms(c['src1'])} | {','.join(c['flags'])} | "
                     f"{_md(c['en'])} | {_md(c['ja'])} | {c['status']} |")
    else:
        L.append("(no rows flagged)")
    if scan:
        rng = [r for r in ja_ranges(scan) if r["end"] > clip_start and r["start"] < clip_start + float(meta.get("clipDurationSec", 0))]
        L.append("")
        covered = max(e["end"] for e in scan)
        L.append(f"Language scan (Transcribe language ID, scanned up to {fmt_hms(covered)} of the recording) ja-JP "
                 "ranges inside this clip: "
                 + (", ".join(f"{fmt_hms(r['start'])}–{fmt_hms(r['end'])}" for r in rng) if rng else "none"))
    L.append("")

    L.extend(_language_filter_section(parsed, m, bool(scan)))

    L.append("## Chunks")
    L.append("")
    L.append("Source time = position in the recording. e2e = e2eFirstWordMs (first English word spoken → first "
             "Japanese sample heard). Rate = Polly speed (%). Lvl = speed level (SPEED_MODE=levels; steps mode logs "
             "1 + steps applied). Speed timeline = rate glyph (▁ 100% … █ 150%), level, ↑/↓ vs the previous "
             "synthesized chunk, ! = urgent jump.")
    L.append("")
    if show_llm:
        L.append("Eng = translate engine (`llm`, `translate`, `fb:<reason>` = LLM fell back to Amazon Translate).")
        L.append("")
    L.append("| # | Source time | Reason | " + ("Eng | " if show_llm else "") +
             "EN | JA | Rate | Lvl | Speed timeline | e2e ms | Status | Flags |")
    L.append("|---|---|---|" + ("---|" if show_llm else "") + "---|---|---|---|---|---|---|---|")
    prev = None
    for c in parsed["chunks"].values():
        cell = speed_cell(c, prev)
        if c.get("rate") is not None:
            prev = c
        L.append(f"| {c['n']} | {fmt_hms(c['src0'])}–{fmt_hms(c['src1'])} | {c['reason']} | "
                 f"{(eng_cell(c) + ' | ') if show_llm else ''}{_md(c['en'])} | "
                 f"{_md(c['ja'])} | {c['rate'] if c['rate'] is not None else ''} | "
                 f"{c['level'] if c.get('level') is not None else ''} | {cell} | "
                 f"{c['e2e'] if c['e2e'] is not None else ''} | {c['status']} | {','.join(c['flags'])} |")
    L.append("")

    L.append("## HUMAN JUDGEMENT")
    L.append("")
    existing = run_dir / "report.md"
    judgement = JUDGE_TEMPLATE
    if existing.exists():
        old = existing.read_text(encoding="utf-8")
        if JUDGE_START in old and JUDGE_END in old:
            judgement = JUDGE_START + old.split(JUDGE_START, 1)[1].split(JUDGE_END, 1)[0] + JUDGE_END
    L.append(judgement)
    L.append("")
    m["judgement"] = parse_judgement(judgement)
    m["label"] = meta.get("label")
    m["mode"] = meta.get("mode")
    m["input"] = cloud_input(meta) if meta.get("mode") == "cloud" else None
    m["file"] = meta.get("fileStem")
    m["clip"] = f"{fmt_hms(clip_start)}+{meta.get('clipDurationSec', 0):.0f}s"
    return "\n".join(L), dict(metrics=m, chunks=list(parsed["chunks"].values()))


COMPARE_ROWS = [
    ("label", "Label"), ("mode", "Mode"), ("input", "Input"), ("file", "Recording"), ("clip", "Clip"), ("chunks", "Chunks"),
    ("reasons", "COMMIT reasons"), ("played", "Played"), ("dropped", "Dropped"), ("skipped", "Skipped"),
    ("failed", "Failed"), ("avgE2eFirstWordMs", "avg e2eFirstWordMs"), ("p90E2eFirstWordMs", "p90 e2eFirstWordMs"),
    ("maxE2eFirstWordMs", "max e2eFirstWordMs"),
    ("sentenceStartLagAvgMs", "avg sentenceStartLagMs"), ("sentenceStartLagP50Ms", "median sentenceStartLagMs"),
    ("sentenceStartLagP90Ms", "p90 sentenceStartLagMs"), ("sentenceStartCount", "sentences (sentenceStartLagMs)"),
    ("avgE2eLastWordMs", "avg e2eLastWordMs"),
    ("p50E2eLastWordMs", "p50 e2eLastWordMs"), ("p90E2eLastWordMs", "p90 e2eLastWordMs"),
    ("maxE2eLastWordMs", "max e2eLastWordMs"), ("avgCommitLagMs", "avg commitLagMs"),
    ("p90CommitLagMs", "p90 commitLagMs"),
    ("maxBacklogMs", "maxBacklogMs"), ("rateHistogram", "Speed rate histogram"),
    ("levelHistogram", "Speed level histogram"), ("levelChanges", "Level changes"),
    ("levelChangesPerMin", "Level changes per min"), ("maxLevelJump", "Max level jump"),
    ("rateChanges", "Rate changes"), ("rateChangesPerMin", "Rate changes per min"),
    ("maxRateJump", "Max rate jump (pts)"), ("speedWhy", "Speed decisions (speedWhy)"),
    ("medianWords", "Median words/chunk"),
    ("fragDangling", "Fragmentation: dangling ends"), ("fragContinuation", "Fragmentation: continuations"),
    ("fragShort", "Fragmentation: chunks <= 3 words"),
    ("jaAudioSec", "Japanese audio played (s)"), ("flaggedNonEnglish", "Rows flagged non-English"),
    ("langscanJaPlayed", "Played chunks overlapping langscan-ja"),
    ("langDropped", "Lang-filter drops"), ("langDroppedWords", "Lang-filter dropped words"),
    ("langDroppedJa", "Lang-filter drops in JA ranges"), ("langDroppedSuspect", "Lang-filter suspected false drops"),
    ("verify", "[verify] OK/MISMATCH/LANGDROP"),
    ("engineSplit", "Engine split (llm/translate/fallback)"),
    ("llmMsAvg", "avg llmMs"), ("llmMsP50", "p50 llmMs"), ("llmMsP90", "p90 llmMs"), ("llmMsMax", "max llmMs"),
    ("translateMsAvg", "avg translateMs (translate engine)"), ("translateMsP50", "p50 translateMs (translate engine)"),
    ("translateMsP90", "p90 translateMs (translate engine)"),
    ("fallbackByReason", "LLM fallbacks by reason"), ("llmFallbackLines", "LLM_FALLBACK lines"),
    ("llmRejectLines", "LLM_REJECT lines"), ("breakerOpened", "LLM breaker opened"),
    ("cacheHitRate", "LLM cache hit rate"), ("llmInTok", "LLM input tokens"), ("llmOutTok", "LLM output tokens"),
    ("llmCacheRead", "LLM cache read tokens"), ("llmCacheWrite", "LLM cache write tokens"),
    ("estUsd", "LLM est. USD (list price, jp. premium not included)"),
    ("errors", "ERROR lines"),
]
# Rows that exist only for runs whose logs carry engine= (hidden in a compare when neither run has them).
LLM_COMPARE_KEYS = frozenset(k for k, _ in COMPARE_ROWS[COMPARE_ROWS.index(("engineSplit", "Engine split (llm/translate/fallback)")):]
                             if k != "errors")


def _fmt(v) -> str:
    if isinstance(v, dict):
        return ", ".join(f"{k}={x}" for k, x in v.items()) or "-"
    return "-" if v is None else str(v)


def compare(a_dir: Path, b_dir: Path, a: dict, b: dict) -> str:
    L = [f"# Compare: `{a_dir.name}` vs `{b_dir.name}`", ""]
    if a.get("file") != b.get("file") or a.get("clip") != b.get("clip"):
        L.append("> Warning: the two runs used different audio (recording or clip); metrics are not directly comparable.")
        L.append("")
    if a.get("input") and b.get("input") and a["input"] != b["input"]:
        L.append(f"> Warning: the two runs used different inputs ({a['input']} vs {b['input']}); the codec, transport "
                 "and decoder start-up differ, so first-word delays are not directly comparable.")
        L.append("")
    L.append(f"| Metric | A | B |")
    L.append("|---|---|---|")
    for key, title in COMPARE_ROWS:
        if key in LLM_COMPARE_KEYS and a.get(key) is None and b.get(key) is None:
            continue
        L.append(f"| {title} | {_md(_fmt(a.get(key)))} | {_md(_fmt(b.get(key)))} |")
    crit = list(OrderedDict.fromkeys(list(a.get("judgement", {})) + list(b.get("judgement", {}))))
    if crit:
        for c in crit:
            L.append(f"| Human: {_md(c)} | {a.get('judgement', {}).get(c, '-')} | {b.get('judgement', {}).get(c, '-')} |")
    else:
        L.append("| Human judgement | (not filled in) | (not filled in) |")
    L.append("")
    L.append(f"A = `{a_dir}`  ")
    L.append(f"B = `{b_dir}`")
    L.append("")
    L.append("Listen: open both `side-by-side.wav` files (left = English source, right = Japanese) and compare the "
             "same passages.")
    return "\n".join(L) + "\n"
