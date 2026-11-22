"""Two-channel (bilingual) parts of the E2E reports (Python stdlib only).

A two-lane app run tags every per-lane log line with ch=<id>:  [chunk 12 ch=en] COMMIT ... src="..." and
[chunk 12 ch=en] SYNTH ... out="...", [langfilter] ch=en stream=1 ..., [summary] ch=en ... A lane whose source is
Japanese writes src="..." / out="..." instead of en="..." / ja="...". This module turns such a log back into the
one-channel line format, so report.parse_log and report.metrics work unchanged for each channel, and builds:
  * the per-channel metrics block and routing counts of a two-lane run (section),
  * the scoring sheet of 30 evenly chosen chunks (scoring_sheet),
  * the simple versus full comparison of Japanese segmentation reasons (compare_section),
  * the recorder track list and the per-channel file names (tracks_json, wav_name).
A one-channel log (no ch= tag, no src=) passes through main_lines() untouched, so its report.md does not change.
"""
from __future__ import annotations

import json
import re
import statistics
from collections import Counter, OrderedDict

import report as rpt

RE_CH = re.compile(r" ch=(\w+)")
RE_TAGGED_CHUNK = re.compile(r"\[chunk \d+ ch=\w+\]")
RE_SRC_FIELD = re.compile(r' src="')
RE_STREAM = re.compile(
    r"\[langfilter\] stream=\d+ results=(\d+) kept=(\d+) dropped=(\d+) droppedWords=(\d+) late=(\d+) carried=(\d+) repeats=(\d+)"
    r"(?: lateSpoken=(\d+))?")
RE_COMMIT_REASON = re.compile(r"\[chunk \d+(?: ch=\w+)?\] COMMIT reason=(\S+) mode=(\S+) ")
SWITCH_GAP_S = 8.0  # a gap this long between two chunks of one channel = the other language was speaking


def _split_line(raw: str) -> tuple[str, str]:
    """(prefix, message): the timestamp and level, and the rest."""
    m = rpt.RE_LINE.match(raw)
    if not m:
        return raw, ""
    iso, level, msg = m.groups()
    return f"{iso} {level} ", msg


def has_channels(lines: list[str]) -> bool:
    return any(RE_TAGGED_CHUNK.search(x) for x in lines)


def has_ja_source(lines: list[str]) -> bool:
    return any(" COMMIT " in x and RE_SRC_FIELD.search(x) for x in lines)


def channels_in(lines: list[str]) -> list[str]:
    seen: "OrderedDict[str, None]" = OrderedDict()
    for x in lines:
        m = re.search(r"\[chunk \d+ ch=(\w+)\]", x)
        if m:
            seen.setdefault(m.group(1), None)
    return list(seen)


def _to_legacy(msg: str) -> str:
    """One lane's message in the one-channel format: no ch= tag, src/out fields named en/ja."""
    msg = RE_CH.sub("", msg, count=1)
    msg = msg.replace(' src="', ' en="').replace(' out="', ' ja="')
    return msg


def _ordered(found: list[str], order: list[str] | None) -> list[str]:
    """Channels in the configured order (channels of config.json), then any others in the order the log shows them."""
    first = [c for c in (order or []) if c in found]
    return first + [c for c in found if c not in first]


def split_channel_lines(lines: list[str], order: list[str] | None = None) -> "OrderedDict[str, list[str]]":
    """Per channel: its own lines (legacy format) plus the shared lines (session starts, errors). [verify] lines carry
    no lane, so they are left out of every channel (the run-level count is in the main report)."""
    chans = _ordered(channels_in(lines), order)
    out: "OrderedDict[str, list[str]]" = OrderedDict((c, []) for c in chans)
    for raw in lines:
        prefix, msg = _split_line(raw)
        if not msg:
            continue
        m = RE_CH.search(msg)
        if m and m.group(1) in out:
            out[m.group(1)].append(prefix + _to_legacy(msg))
        elif msg.startswith("[verify]"):
            continue
        elif not RE_CH.search(msg):
            for c in out:
                out[c].append(raw)
    return out


def main_lines(lines: list[str], order: list[str] | None = None) -> list[str]:
    """The log the standard report is built from: the whole log for a one-channel run, the first (default) channel for a
    two-lane run, and the log with src/out renamed for a run whose only lane has a Japanese source."""
    if has_channels(lines):
        chans = split_channel_lines(lines, order)
        return next(iter(chans.values())) if chans else lines
    if has_ja_source(lines):
        out = []
        for raw in lines:
            prefix, msg = _split_line(raw)
            out.append(prefix + _to_legacy(msg) if msg else raw)
        return out
    return lines


def _pct(vals: list[float], p: int):
    return rpt.pct(vals, p)


def channel_metrics(lines: list[str], clip_sec: float | None = None, order: list[str] | None = None) -> "OrderedDict[str, dict]":
    out: "OrderedDict[str, dict]" = OrderedDict()
    for ch, ls in split_channel_lines(lines, order).items():
        parsed = rpt.parse_log(ls)
        m = rpt.metrics(parsed, clip_sec)
        m["switches"] = _switch_stats(list(parsed["chunks"].values()))
        out[ch] = m
    return out


def _switch_stats(chunks: list[dict]) -> dict:
    """First chunk after a pause of SWITCH_GAP_S or more in this channel: how late its first word is heard."""
    firsts = []
    prev_end = None
    for c in sorted(chunks, key=lambda c: c.get("rel0", c["a0"])):
        start = c.get("rel0", c["a0"])
        end = c.get("rel1", c["a1"])
        if prev_end is not None and start - prev_end >= SWITCH_GAP_S and c.get("e2e") is not None:
            firsts.append(c["e2e"])
        prev_end = max(prev_end or 0, end)
    return {"count": len(firsts), "medianE2eFirstWordMs": int(statistics.median(firsts)) if firsts else None}


def routing_counts(lines: list[str]) -> "OrderedDict[str, dict]":
    """Per channel, summed over the Transcribe streams of the run: results, kept, dropped, late, lateSpoken."""
    out: "OrderedDict[str, Counter]" = OrderedDict()
    for raw in lines:
        _, msg = _split_line(raw)
        m = RE_CH.search(msg) if msg.startswith("[langfilter]") else None
        if not m:
            continue
        mm = RE_STREAM.search(RE_CH.sub("", msg, count=1))
        if not mm:
            continue
        c = out.setdefault(m.group(1), Counter())
        for key, val in zip(("results", "kept", "dropped", "droppedWords", "late", "carried", "repeats", "lateSpoken"), mm.groups()):
            c[key] += int(val or 0)
    return OrderedDict((k, dict(v)) for k, v in out.items())


def _cell(v) -> str:
    return "-" if v is None else str(v)


ROWS = [
    ("chunks", "Chunks"), ("played", "Played"), ("dropped", "Dropped (backlog)"), ("skipped", "Skipped"), ("failed", "Failed"),
    ("p50E2eFirstWordMs", "p50 e2eFirstWordMs"), ("p90E2eFirstWordMs", "p90 e2eFirstWordMs"),
    ("p50E2eLastWordMs", "p50 e2eLastWordMs"), ("p90E2eLastWordMs", "p90 e2eLastWordMs"),
    ("avgCommitLagMs", "avg commitLagMs"), ("p90CommitLagMs", "p90 commitLagMs"), ("maxBacklogMs", "maxBacklogMs"),
    ("reasons", "COMMIT reasons"), ("medianWords", "Median words (characters for a Japanese source)/chunk"),
    ("errors", "ERROR lines"),
]


def section(lines: list[str], meta: dict | None = None, clip_sec: float | None = None) -> list[str]:
    """Markdown lines for a two-lane run: one metrics column per channel, routing counts, first chunk after a switch."""
    chans = channel_metrics(lines, clip_sec, (meta or {}).get("channels"))
    ids = list(chans)
    L = ["", "## Channels (two-lane run)", ""]
    L.append("Each channel is computed from its own log lines (`ch=<id>`). The main report above is the first channel in "
             f"the configured `channels` order (`{ids[0] if ids else '-'}`).")
    L.append("")
    L.append("| Metric | " + " | ".join(f"`{c}`" for c in ids) + " |")
    L.append("|---|" + "---|" * len(ids))
    for key, title in ROWS:
        cells = []
        for c in ids:
            v = chans[c].get(key)
            cells.append(", ".join(f"{k}={x}" for k, x in v.items()) if isinstance(v, dict) else _cell(v))
        L.append(f"| {title} | " + " | ".join(rpt._md(x) for x in cells) + " |")
    L.append("")
    L.append("### Routing (language gate per channel)")
    L.append("")
    route = routing_counts(lines)
    L.append("| Channel | results | kept | dropped | dropped words | late flips | lateSpoken | carried |")
    L.append("|---|---|---|---|---|---|---|---|")
    for c in ids:
        r = route.get(c, {})
        L.append(f"| `{c}` | {r.get('results', '-')} | {r.get('kept', '-')} | {r.get('dropped', '-')} | {r.get('droppedWords', '-')} | "
                 f"{r.get('late', '-')} | {r.get('lateSpoken', '-')} | {r.get('carried', '-')} |")
    L.append("")
    L.append("A result is kept by exactly the channel whose source language it is in; `dropped` are the other language's "
             "results. `lateSpoken` counts late language flips after text was already emitted.")
    L.append("")
    L.append(f"### First chunk after a switch (a gap of {SWITCH_GAP_S:.0f} s or more in the channel)")
    L.append("")
    L.append("| Channel | switches | median e2eFirstWordMs of the first chunk after one |")
    L.append("|---|---|---|")
    for c in ids:
        s = chans[c]["switches"]
        L.append(f"| `{c}` | {s['count']} | {_cell(s['medianE2eFirstWordMs'])} |")
    L.append("")
    return L


# ---------------------------------------------------------------- scoring sheet
def scoring_chunks(lines: list[str], channel: str | None = None, n: int = 30) -> tuple[str, list[dict]]:
    """n played chunks of the Japanese-source channel (its source text and the English), evenly spread over the run."""
    if has_channels(lines):
        per = split_channel_lines(lines)
        ch = channel or ("en" if "en" in per else next(iter(per)))
        ls = per[ch]
    else:
        ch = channel or "en"
        ls = main_lines(lines)
    parsed = rpt.parse_log(ls)
    played = [c for c in parsed["chunks"].values() if c["status"] == "played" and c["ja"]]
    if len(played) <= n:
        return ch, played
    step = len(played) / n
    return ch, [played[int(i * step)] for i in range(n)]


def scoring_sheet(lines: list[str], channel: str | None = None, n: int = 30) -> str:
    ch, chosen = scoring_chunks(lines, channel, n)
    L = [f"# Scoring sheet: channel `{ch}`", ""]
    L.append(f"{len(chosen)} chunks chosen evenly over the run. Score each translation from 1 (wrong or unusable) to 5 (as a good "
             "interpreter would say it): meaning first, then fluency. The quality floor for channel 2 is the median score of "
             "channel 1 minus 0.5. Fill in the last column and keep the file; it holds synthetic or your own recordings only.")
    L.append("")
    L.append("| # | Chunk | Source | Translation | Score (1-5) |")
    L.append("|---|---|---|---|---|")
    for i, c in enumerate(chosen, 1):
        L.append(f"| {i} | {c['n']} | {rpt._md(c['en'])} | {rpt._md(c['ja'])} |  |")
    L.append("")
    L.append("Median score: ____    Channel 1 median: ____    Floor (channel 1 median minus 0.5): ____    Result: pass / fail")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------- simple versus full
def japanese_reasons(lines: list[str]) -> tuple[str, Counter]:
    """(segmentation mode, reasons) of the Japanese-source chunks of a run: those whose COMMIT line has src=."""
    reasons: Counter = Counter()
    mode = ""
    for raw in lines:
        _, msg = _split_line(raw)
        if " COMMIT " not in msg or not RE_SRC_FIELD.search(msg):
            continue
        m = RE_COMMIT_REASON.search(msg)
        if m:
            reasons[m.group(1)] += 1
            mode = m.group(2)
    return mode, reasons


def compare_section(lines_a: list[str], lines_b: list[str]) -> str:
    """The Japanese segmentation reasons of two runs side by side (empty string when neither run has a Japanese source)."""
    (ma, ra), (mb, rb) = japanese_reasons(lines_a), japanese_reasons(lines_b)
    if not ra and not rb:
        return ""
    L = ["", "## Japanese segmentation (chunk cuts by reason)", "", f"| Reason | A (mode {ma or '-'}) | B (mode {mb or '-'}) |", "|---|---|---|"]
    for reason in sorted(set(ra) | set(rb)):
        L.append(f"| {reason} | {ra.get(reason, 0)} | {rb.get(reason, 0)} |")
    L.append(f"| total | {sum(ra.values())} | {sum(rb.values())} |")
    L.append("")
    L.append("Run once with `jaSegmentationMode=simple` and once with `full` on the same recording. The extra rules of `full` "
             "are worth keeping only if the scoring sheets show a clear quality gain without a later first word.")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------- recorder
def drain_state(lines: list[str], session: int, lanes: list[str] | None = None) -> tuple[bool, list[tuple[str, int]]]:
    """(every lane logged its [summary] for this session, chunks not yet final as (channel, number)).
    One-lane logs have an untagged `[summary] session=<n> ` and untagged chunks (channel ""); with lanes, a tagged
    summary is required for every lane (the configured ones, else those seen in the log)."""
    tagged = has_channels(lines) or bool(lanes and len(lanes) > 1)
    need = (list(lanes) if lanes else channels_in(lines)) if tagged else []
    seen = set()
    for x in lines:
        _, msg = _split_line(x)
        m = re.match(rf"\[summary\] (?:ch=(\w+) )?session={session} ", msg or x)
        if m:
            seen.add(m.group(1) or "")
    summary_ok = all(c in seen for c in need) if need else bool(seen)
    pairs = split_channel_lines(lines).items() if tagged else [("", lines)]
    open_chunks: list[tuple[str, int]] = []
    for ch, ls in pairs:
        parsed = rpt.parse_log(ls)
        open_chunks += [(ch, c["n"]) for c in parsed["chunks"].values() if c["status"] in ("queued", "synth")]
    return summary_ok, open_chunks


def files_line(channels: list[str]) -> str:
    """The `Files:` line of report.md for a run with these channels (empty or one: the one-channel line)."""
    if len(channels) < 2:
        return ("Files: `translation.wav` (Japanese output, sample 0 = stream start), `source-clip.wav` (English input), "
                "`side-by-side.wav` (left = source, right = translation, time-aligned), `app.log`, `report.md`.")
    per = ", ".join(f"`{wav_name(c)}`" for c in channels)
    sbs = ", ".join(f"`side-by-side-{c}.wav`" for c in channels)
    return (f"Files: {per} (one output per channel, sample 0 = stream start), `source-clip.wav` (input), {sbs} "
            "(left = source, right = translation, time-aligned), `scoring-sheet.md`, `app.log`, `report.md`.")


def wav_name(channel: str | None) -> str:
    """translation.wav for one channel; translation-<id>.wav for each channel of a two-lane run."""
    return "translation.wav" if not channel else f"translation-{channel}.wav"


def tracks_json(channels: list[dict], out_paths: dict[str, str]) -> str:
    """The recorder's track list from the channels of config.json (id, publisher, track) and the output paths."""
    return json.dumps([{"id": c["id"], "publisher": c["publisher"], "track": c["track"], "out": out_paths[c["id"]]} for c in channels])


def listener_channels(config_json: dict | None) -> list[dict]:
    """The channel list of config.json when it has two or more entries, else [] (one channel: today's single recording)."""
    ch = (config_json or {}).get("channels")
    if not isinstance(ch, list) or len(ch) < 2:
        return []
    return [c for c in ch if isinstance(c, dict) and all(isinstance(c.get(k), str) for k in ("id", "publisher", "track"))]
