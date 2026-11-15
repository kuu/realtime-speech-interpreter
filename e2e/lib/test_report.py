"""Unit tests for the language-filter parts of report.py (stdlib unittest).

Run: python3 -m unittest discover -s e2e/lib -p 'test_report.py'
"""
import tempfile
import unittest
from pathlib import Path

import report as rpt

# t0 (Transcribe stream time 0) = 2026-11-12T06:00:00.000Z for every line below.
NEW_LOG = """\
2026-11-12T06:00:00.000Z INFO Simultaneous translation app starting
2026-11-12T06:00:00.001Z INFO   langfilter mode=langid options=en-US,ja-JP settleWords=5 shortWords=4 shortMinConf=0.6
2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream
2026-11-12T06:00:06.500Z INFO [langfilter] dropped result=aaaa1111 reason=non-english lang=ja-JP words=7 conf=0.91 audio=0.50-6.00s lagMs=500 text="はい、それでは始めます。"
2026-11-12T06:00:12.400Z INFO [chunk 1] COMMIT reason=sentence mode=clause words=9 result=bbbb2222 audio=7.00-12.00s commitLagMs=400 queueDepth=1 en="Thank you for coming to this session today, everyone."
2026-11-12T06:00:12.401Z INFO [verify] result=bbbb2222 items=11 committed=11 OK final="Thank you for coming to this session today, everyone."
2026-11-12T06:00:12.600Z INFO [chunk 1] SYNTH translateMs=100 synthMs=100 rate=100 backlogMs=600 sinkQueuedMs=0 queueDepth=0 pcmBytes=32000 audioMs=1000 ja="本日はお越しいただきありがとうございます。"
2026-11-12T06:00:13.000Z INFO [chunk 1] PLAYED writtenBytes=32000 pcmBytes=32000 waitMs=0 backlogMs=1000 e2eFirstWordMs=6000 e2eLastWordMs=1000
2026-11-12T06:00:20.300Z INFO [langfilter] dropped result=cccc3333 reason=short-low-conf lang=en-US words=1 conf=0.50 audio=19.00-20.00s lagMs=300 text="more."
2026-11-12T06:00:21.000Z WARN [verify] result=dddd4444 committed=6 emitted=0 removed=6 LANGDROP lang=ja-JP (language switched after commit)
2026-11-12T06:00:30.000Z INFO [langfilter] stream=1 results=4 kept=1 dropped=3 droppedWords=14 late=1
"""

OLD_LOG = """\
2026-11-12T06:00:00.000Z INFO Simultaneous translation app starting
2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream
2026-11-12T06:00:12.400Z INFO [chunk 1] COMMIT reason=sentence mode=clause words=9 result=bbbb2222 audio=7.00-12.00s commitLagMs=400 queueDepth=1 en="Thank you for coming to this session today, everyone."
2026-11-12T06:00:12.401Z INFO [verify] result=bbbb2222 items=11 committed=11 OK final="Thank you for coming to this session today, everyone."
"""


class ParseLogTest(unittest.TestCase):
    def test_drops_and_verify(self):
        p = rpt.parse_log(NEW_LOG.splitlines())
        self.assertEqual(len(p["drops"]), 2)
        self.assertEqual(p["verify"], {"OK": 1, "LANGDROP": 1})
        self.assertTrue(p["langfilterSeen"])
        d0, d1 = p["drops"]
        self.assertEqual((d0["reason"], d0["lang"], d0["words"], d0["conf"]), ("non-english", "ja-JP", 7, 0.91))
        self.assertEqual(d0["text"], "はい、それでは始めます。")
        self.assertEqual(d1["reason"], "short-low-conf")
        # Same t0 as the chunk → drop times are stream times on the chunk's timeline.
        c = p["chunks"][1]
        self.assertAlmostEqual(c["rel0"], 7.0)
        self.assertAlmostEqual(d0["rel0"], 0.5)
        self.assertAlmostEqual(d0["rel1"], 6.0)
        self.assertAlmostEqual(d1["rel0"], 19.0)

    def test_old_format_log(self):
        p = rpt.parse_log(OLD_LOG.splitlines())
        self.assertEqual(p["drops"], [])
        self.assertFalse(p["langfilterSeen"])
        self.assertEqual(p["verify"], {"OK": 1})
        self.assertAlmostEqual(p["chunks"][1]["rel0"], 7.0)

    def test_drops_only(self):
        lines = [l for l in NEW_LOG.splitlines() if "[chunk" not in l]
        p = rpt.parse_log(lines)
        self.assertAlmostEqual(p["drops"][0]["rel0"], 0.0 + 0.5)
        self.assertAlmostEqual(p["drops"][1]["rel0"], 19.0)

    def test_report_section_and_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs = Path(tmp)
            (runs / "langscan").mkdir()
            # ja-JP from 100.0 to 106.8 s of the file; clip starts at 100 s → drop 0 overlaps, drop 1 does not.
            (runs / "langscan" / "rec.jsonl").write_text(
                '{"lang": "ja-JP", "start": 100.0, "end": 106.8, "text": "x"}\n'
                '{"lang": "en-US", "start": 106.8, "end": 200.0, "text": "y"}\n', encoding="utf-8")
            run = runs / "run1"
            run.mkdir()
            meta = dict(mode="local", label="t", fileStem="rec", clipStartSec=100, clipDurationSec=60)
            text, data = rpt.build_report(run, meta, NEW_LOG.splitlines(), [], {}, runs)
        m = data["metrics"]
        self.assertEqual(m["langDropped"], 2)
        self.assertEqual(m["langDroppedWords"], 8)
        self.assertEqual(m["langDroppedJa"], 1)
        self.assertEqual(m["langDroppedSuspect"], 1)
        self.assertEqual((m["verifyOk"], m["verifyMismatch"], m["verifyLangdrop"]), (1, 0, 1))
        self.assertEqual(m["langscanJaPlayed"], 1)  # chunk 1 starts 0.5 s after the ja range (tolerance)
        self.assertIn("## Language filter", text)
        self.assertIn("| Suspected false drops of English (no langscan-ja overlap) | 1 |", text)
        self.assertIn("langfilter.mode", text)  # settings table
        # Suspected false drop listed first.
        rows = [l for l in text.splitlines() if "| non-english |" in l or "| short-low-conf |" in l]
        self.assertEqual(len(rows), 2, rows)
        self.assertIn("| short-low-conf | en-US | 1 | 0.50 | **no** | more. |", rows[0])
        self.assertIn("| non-english | ja-JP | 7 | 0.91 | yes |", rows[1])

    def test_report_old_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run1"
            run.mkdir()
            meta = dict(mode="local", label="t", fileStem="rec", clipStartSec=0, clipDurationSec=60)
            text, data = rpt.build_report(run, meta, OLD_LOG.splitlines(), [], {}, Path(tmp))
        self.assertIn("no language-filter lines (filter off or older build)", text)
        self.assertEqual(data["metrics"]["langDropped"], 0)


def _speed_log(rows: list[tuple[int | None, int, str | None]]) -> list[str]:
    """Chunks 1..N, 10 s apart, with SYNTH lines (level, rate, speedWhy); level None = old format."""
    out = ["2026-11-12T06:00:00.000Z INFO Simultaneous translation app starting",
           "2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream"]
    for i, (level, rate, why) in enumerate(rows, start=1):
        a0, a1 = 10 * i, 10 * i + 4
        ts = f"2026-11-12T06:{(a1 + 1) // 60:02d}:{(a1 + 1) % 60:02d}.000Z"
        out.append(f"{ts} INFO [chunk {i}] COMMIT reason=sentence mode=clause words=9 result=r{i} "
                   f"audio={a0}.00-{a1}.00s commitLagMs=1000 queueDepth=1 en=\"Sentence number {i} is here.\"")
        lv = f"level={level} " if level is not None else ""
        extra = f"signalMs=3100 estMs=1650 speedWhy={why} " if why else ""
        out.append(f"{ts} INFO [chunk {i}] SYNTH translateMs=100 synthMs=100 {lv}rate={rate} backlogMs=3000 "
                   f"{extra}sinkQueuedMs=0 queueDepth=0 pcmBytes=32000 audioMs=1000 ja=\"文{i}です。\"")
        out.append(f"{ts} INFO [chunk {i}] PLAYED writtenBytes=32000 pcmBytes=32000 waitMs=0 backlogMs=3000 "
                   f"e2eFirstWordMs=7000 e2eLastWordMs=3000")
    return out


class SpeedMetricsTest(unittest.TestCase):
    def _report(self, lines):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run1"
            run.mkdir()
            meta = dict(mode="local", label="t", fileStem="rec", clipStartSec=0, clipDurationSec=60)
            return rpt.build_report(run, meta, lines, [], {}, Path(tmp))

    def test_levels_log(self):
        rows = [(1, 100, "target"), (2, 110, "target"), (3, 120, "slew"), (3, 120, "hold"), (2, 110, "target")]
        p = rpt.parse_log(_speed_log(rows))
        self.assertEqual([c["level"] for c in p["chunks"].values()], [1, 2, 3, 3, 2])
        self.assertEqual(p["chunks"][3]["speedWhy"], "slew")
        self.assertEqual(p["chunks"][3]["ja"], "文3です。")
        text, data = self._report(_speed_log(rows))
        m = data["metrics"]
        self.assertEqual(m["levelChanges"], 3)
        self.assertEqual(m["maxLevelJump"], 1)
        self.assertEqual(m["levelHistogram"], {"L1": 1, "L2": 2, "L3": 2})
        self.assertEqual(m["rateChanges"], 3)
        self.assertEqual(m["maxRateJump"], 10)
        self.assertEqual(m["levelChangesPerMin"], 3.0)
        self.assertEqual(m["speedWhy"], {"target": 3, "slew": 1, "hold": 1})
        self.assertIn("| Level changes (per min) / max jump | 3 (3.0/min) / 1 |", text)
        self.assertIn("| Rate | Lvl | Speed timeline |", text)
        self.assertIn("## Speed timeline", text)
        self.assertIn("(L1 L2 L3 L3 L2)", text)
        self.assertIn("| 110 | 2 | ▂ L2↓ |", text)

    def test_old_format_rates(self):
        rows = [(None, 100, None), (None, 115, None), (None, 115, None), (None, 130, None)]
        text, data = self._report(_speed_log(rows))
        m = data["metrics"]
        self.assertEqual(m["levelHistogram"], {})
        self.assertIsNone(m["levelChanges"])
        self.assertEqual(m["rateChanges"], 2)
        self.assertEqual(m["maxRateJump"], 15)
        self.assertEqual(m["rateHistogram"], {"100": 1, "115": 2, "130": 1})
        self.assertIn("| Speed level histogram (SYNTH level=) | - |", text)
        self.assertIn("| Level changes (per min) / max jump | - |", text)
        self.assertIn("(100 115 115 130)", text)

    def test_old_log_max_rate_jump(self):
        _, data = self._report(_speed_log([(None, 100, None), (None, 150, None), (None, 100, None)]))
        self.assertEqual(data["metrics"]["maxRateJump"], 50)
        self.assertEqual(data["metrics"]["rateChanges"], 2)

    def test_urgent_glyph_and_scale(self):
        self.assertEqual(rpt.speed_glyph(100), "▁")
        self.assertEqual(rpt.speed_glyph(150), "█")
        self.assertEqual(rpt.speed_glyph(200), "█")
        text, _ = self._report(_speed_log([(1, 100, "target"), (5, 145, "urgent")]))
        self.assertIn("L5↑!", text)
        self.assertIn("(L1 L5!)", text)



def _llm_log(old_format: bool = False) -> list[str]:
    """Four chunks, 10 s apart: llm, fallback(timeout), translate, fallback(breaker-open, no llmMs)."""
    out = ["2026-11-12T06:00:00.000Z INFO Simultaneous translation app starting",
           "2026-11-12T06:00:00.001Z INFO   translate engine=llm formality=FORMAL correction=on",
           "2026-11-12T06:00:00.001Z INFO   llm engine=llm model=jp.anthropic.claude-haiku-4-5-20251001-v1:0 "
           "timeoutMs=1500 contextChunks=3 glossary=full(393)",
           "2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream"]
    extras = [" engine=llm llmMs=600 inTok=100 outTok=20 cacheRead=5000 cacheWrite=0",
              " engine=fallback fallbackReason=timeout llmMs=1500",
              " engine=translate",
              " engine=fallback fallbackReason=breaker-open"]
    tr = [650, 1700, 120, 90]
    for i, extra in enumerate(extras, start=1):
        a0, a1 = 10 * i, 10 * i + 4
        ts = f"2026-11-12T06:00:{a1 + 1:02d}.000Z"
        out.append(f"{ts} INFO [chunk {i}] COMMIT reason=sentence mode=clause words=9 result=r{i} "
                   f"audio={a0}.00-{a1}.00s commitLagMs={1000 * i} queueDepth=1 en=\"Sentence number {i} is here.\"")
        if i == 2:
            out.append(f"{ts} WARN [chunk 2] LLM_FALLBACK reason=timeout llmMs=1503 detail=\"t\" en=\"Sentence number 2 is here.\"")
            out.append(f"{ts} WARN [llm] BREAKER open reason=\"3 consecutive timeout\" forMs=30000")
        if i == 3:
            out.append(f"{ts} WARN [chunk 3] LLM_REJECT rule=english-run detail=\"d\" ja=\"x\" en=\"e\"")
        out.append(f"{ts} INFO [chunk {i}] SYNTH translateMs={tr[i - 1]} synthMs=100 rate=100 backlogMs=3000 "
                   f"sinkQueuedMs=0 queueDepth=0{'' if old_format else extra} pcmBytes=32000 audioMs=1000 ja=\"文{i}です。\"")
        out.append(f"{ts} INFO [chunk {i}] PLAYED writtenBytes=32000 pcmBytes=32000 waitMs=0 backlogMs=3000 "
                   f"e2eFirstWordMs={7000 + 1000 * i} e2eLastWordMs={2000 * i}")
    out.append("2026-11-12T06:01:00.000Z INFO [summary] exit chunks=4")
    out.append("2026-11-12T06:01:00.001Z INFO [llm-summary] exit engine=llm used=1 fallback=2 "
               "byReason=timeout:1,breaker-open:1 skipBacklog=0 breakerOpened=1 meanLlmMs=1050 p90LlmMs=1500 "
               "maxLlmMs=1500 cacheHitRate=0.99 inTok=300 outTok=60 cacheRead=15000 cacheWrite=5200 "
               "translateCalls=3 estUsd=0.0123")
    return out


class LlmEngineTest(unittest.TestCase):
    def _report(self, lines, startup=None):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run1"
            run.mkdir()
            meta = dict(mode="local", label="t", fileStem="rec", clipStartSec=0, clipDurationSec=60)
            return rpt.build_report(run, meta, lines, startup or [], {}, Path(tmp))

    def test_parse_new_format(self):
        p = rpt.parse_log(_llm_log())
        c = p["chunks"]
        self.assertEqual((c[1]["engine"], c[1]["llmMs"], c[1]["inTok"], c[1]["outTok"], c[1]["cacheRead"],
                          c[1]["cacheWrite"], c[1]["translateMs"]), ("llm", 600, 100, 20, 5000, 0, 650))
        self.assertEqual((c[2]["engine"], c[2]["fallbackReason"], c[2]["llmMs"]), ("fallback", "timeout", 1500))
        self.assertEqual((c[3]["engine"], c[3]["llmMs"], c[3]["translateMs"]), ("translate", None, 120))
        self.assertEqual((c[4]["fallbackReason"], c[4]["llmMs"]), ("breaker-open", None))
        self.assertEqual(c[4]["ja"], "文4です。")
        self.assertEqual(p["llmFallbackLines"], {"timeout": 1})
        self.assertEqual(p["llmRejectLines"], {"english-run": 1})
        self.assertEqual(p["breakerOpened"], 1)
        self.assertEqual(p["llmSummary"]["used"], "1")
        self.assertEqual(p["llmSummary"]["estUsd"], "0.0123")
        self.assertEqual(p["llmSummary"]["byReason"], "timeout:1,breaker-open:1")

    def test_llm_metrics(self):
        _, data = self._report(_llm_log())
        m = data["metrics"]
        self.assertEqual(m["engineSplit"], {"llm": 1, "translate": 1, "fallback": 2})
        self.assertEqual((m["llmMsAvg"], m["llmMsP50"], m["llmMsP90"], m["llmMsMax"]), (1050, 600, 1500, 1500))
        self.assertEqual((m["translateMsAvg"], m["translateMsP90"]), (120, 120))
        self.assertEqual(m["fallbackByReason"], {"timeout": 1, "breaker-open": 1})
        self.assertEqual((m["llmFallbackLines"], m["llmRejectLines"], m["breakerOpened"]), (1, 1, 1))
        self.assertAlmostEqual(m["cacheHitRate"], 5000 / 5100, places=4)
        self.assertEqual((m["llmInTok"], m["llmOutTok"], m["llmCacheRead"], m["llmCacheWrite"]), (100, 20, 5000, 0))
        self.assertAlmostEqual(m["estUsd"], (100 * 1 + 20 * 5 + 5000 * 0.1) / 1e6, places=4)
        # e2eLast values 2000, 4000, 6000, 8000; commit lag 1000..4000
        self.assertEqual((m["avgE2eLastWordMs"], m["p50E2eLastWordMs"], m["p90E2eLastWordMs"], m["maxE2eLastWordMs"]),
                         (5000, 4000, 8000, 8000))
        self.assertEqual((m["avgCommitLagMs"], m["p90CommitLagMs"]), (2500, 4000))

    def test_llm_report_text(self):
        text, _ = self._report(_llm_log(), [l for l in _llm_log() if "  llm " in l or "  translate " in l])
        self.assertIn("## LLM engine", text)
        self.assertIn("| Chunks llm / translate / fallback | 1 / 1 / 2 |", text)
        self.assertIn("| Fallbacks by reason | timeout=1, breaker-open=1 |", text)
        self.assertIn("list price, jp. premium not included", text)
        self.assertIn("| Breaker opened | 1 |", text)
        self.assertIn("| # | Source time | Reason | Eng | EN | JA |", text)
        self.assertIn("| llm | Sentence number 1 is here. |", text)
        self.assertIn("| fb:timeout | Sentence number 2 is here. |", text)
        self.assertIn("| translate | Sentence number 3 is here. |", text)
        self.assertIn("| llm.engine | `llm` |", text)  # startup "  llm " line is a setting
        self.assertIn("`[llm-summary]` exit", text)
        self.assertIn("| e2eLastWordMs p50 / p90 / max | 4000 / 8000 / 8000 |", text)

    def test_old_format_unchanged(self):
        text, data = self._report(_llm_log(old_format=True))
        m = data["metrics"]
        self.assertNotIn("## LLM engine", text)
        self.assertNotIn("| Eng |", text)
        self.assertIn("| # | Source time | Reason | EN | JA | Rate |", text)
        for k in ("engineSplit", "llmMsAvg", "estUsd", "cacheHitRate", "fallbackByReason"):
            self.assertNotIn(k, m)
        # The older metrics are unchanged by the new parsing.
        self.assertEqual((m["chunks"], m["played"], m["avgE2eFirstWordMs"], m["rateHistogram"]), (4, 4, 9500, {"100": 4}))
        # New all-run metrics exist on old logs.
        self.assertEqual(m["maxE2eLastWordMs"], 8000)

    def test_translate_only_new_format(self):
        lines = [l.replace(" engine=llm llmMs=600 inTok=100 outTok=20 cacheRead=5000 cacheWrite=0", " engine=translate")
                 for l in _llm_log()]
        _, data = self._report([l for l in lines if "fallbackReason" not in l])
        m = data["metrics"]
        self.assertEqual(m["engineSplit"]["llm"], 0)
        self.assertIsNone(m["llmMsAvg"])
        self.assertIsNone(m["cacheHitRate"])
        self.assertEqual(m["estUsd"], 0.0)

    def test_compare_rows(self):
        _, new = self._report(_llm_log())
        _, old = self._report(_llm_log(old_format=True))
        a, b = Path("/x/a"), Path("/x/b")
        text = rpt.compare(a, b, old["metrics"], new["metrics"])
        self.assertIn("| p90 e2eLastWordMs | 8000 | 8000 |", text)
        self.assertIn("| avg commitLagMs | 2500 | 2500 |", text)
        self.assertIn("| Engine split (llm/translate/fallback) | - | llm=1, translate=1, fallback=2 |", text)
        self.assertIn("| p90 llmMs | - | 1500 |", text)
        self.assertIn("| LLM fallbacks by reason | - | timeout=1, breaker-open=1 |", text)
        self.assertIn("jp. premium not included", text)
        # Two old runs: LLM rows are not shown at all.
        text_old = rpt.compare(a, b, old["metrics"], old["metrics"])
        self.assertNotIn("llmMs", text_old)
        self.assertNotIn("Engine split", text_old)


def _ch(n, en):
    return dict(n=n, en=en, ja="")


class FragmentationTest(unittest.TestCase):
    def test_dangling_continuation_short(self):
        chunks = [_ch(1, "The Elemental stack that"), _ch(2, "you're used to."), _ch(3, "We support a set of six,"),
                  _ch(4, "different layouts."), _ch(5, "It is good in"), _ch(6, "MediaLive."),
                  _ch(7, "Uh, we ship it to"), _ch(8, "Okay.")]
        fr = rpt.fragmentation(chunks)
        self.assertEqual([r["n"] for r in fr["dangling"]], [1, 5, 7])  # "of six," and "layouts." do not dangle
        # 2 starts lowercase after chunk 1 (no .?!); 4 after chunk 3 (comma)
        self.assertEqual([r["n"] for r in fr["continuation"]], [2, 4])
        self.assertEqual([r["n"] for r in fr["short"]], [2, 4, 6, 8])

    def test_trailing_punctuation_not_dangling(self):
        fr = rpt.fragmentation([_ch(1, "Where is it?"), _ch(2, "I think so.")])
        self.assertEqual(fr["dangling"], [])
        fr = rpt.fragmentation([_ch(1, "Let's go to."), _ch(2, "And")])
        self.assertEqual([r["n"] for r in fr["dangling"]], [2])

    def test_user_chunk_regression(self):
        chunks = [_ch(1, "the Elemental stack that"), _ch(2, "you're used to."), _ch(3, "We support six different layouts."),
                  _ch(4, "Pull the stream")]
        reg = {r["tail"]: r["state"] for r in rpt.user_chunk_regression(chunks)}
        self.assertEqual(reg["you're used to."], "separate")
        self.assertEqual(reg["different layouts."], "merged")
        self.assertEqual(reg["pull"], "separate")
        self.assertEqual(reg["MediaLive."], "absent")

    def test_report_section(self):
        run = Path(tempfile.mkdtemp())
        text, built = rpt.build_report(run, {"label": "t", "mode": "local", "clipDurationSec": 30}, NEW_LOG.splitlines(), [],
                                       {}, run)
        self.assertIn("## Fragmentation", text)
        self.assertEqual(built["metrics"]["fragDangling"], 0)

    def test_base_runs(self):
        runs = Path(__file__).resolve().parent.parent / "runs"
        for pattern, expected in (("*quality-base_a", (13, 32, 18)),
                                  ("*quality-base_b", (16, 26, 10, 3, 11, 8))):
            dirs = sorted(runs.glob(pattern))
            if not dirs:
                self.skipTest("base run folders not present")
            exp = [expected[i:i + 3] for i in range(0, len(expected), 3)]
            for d, e in zip(dirs, exp):
                m = rpt.metrics(rpt.parse_log((d / "app.log").read_text(encoding="utf-8").splitlines()))
                self.assertEqual((m["fragDangling"], m["fragContinuation"], m["fragShort"]), tuple(e), d.name)


# Sentence start lag: chunk 1 (first of the log) and chunk 3 (after "here.") open sentences; chunk 2 does not.
# Timestamps are chosen so every stage is known: chunk 3 waits 200 ms for the worker and 800 ms behind earlier audio.
def _l(ts, body):
    return f"2026-11-12T06:00:{ts}Z INFO {body}"
SENTENCE_LOG = [
    _l("00.000", "[session 1] first audio received; opening Transcribe stream"),
    _l("05.000", '[chunk 1] COMMIT reason=comma mode=clause words=7 result=aaaa1111 audio=1.00-4.00s commitLagMs=1000 queueDepth=1 en="This is the first part of it,"'),
    _l("05.300", '[chunk 1] SYNTH translateMs=100 synthMs=200 level=2 rate=110 backlogMs=1300 sinkQueuedMs=0 queueDepth=0 pcmBytes=3200 audioMs=100 ja="これは最初です、"'),
    _l("05.310", "[chunk 1] PLAYED writtenBytes=3200 pcmBytes=3200 waitMs=0 backlogMs=1300 e2eFirstWordMs=4300 e2eLastWordMs=1300"),
    _l("08.000", '[chunk 2] COMMIT reason=sentence mode=clause words=4 result=aaaa1111 audio=4.20-7.00s commitLagMs=1000 queueDepth=1 en="and it ends here."'),
    _l("08.300", '[chunk 2] SYNTH translateMs=100 synthMs=200 level=2 rate=110 backlogMs=1300 sinkQueuedMs=0 queueDepth=0 pcmBytes=3200 audioMs=100 ja="ここで終わります。"'),
    _l("08.310", "[chunk 2] PLAYED writtenBytes=3200 pcmBytes=3200 waitMs=0 backlogMs=1300 e2eFirstWordMs=4100 e2eLastWordMs=1300"),
    _l("11.000", '[chunk 3] COMMIT reason=sentence mode=clause words=4 result=aaaa1111 audio=7.50-10.50s commitLagMs=500 queueDepth=1 en="Next sentence begins now."'),
    _l("11.500", '[chunk 3] SYNTH translateMs=100 synthMs=200 level=2 rate=110 backlogMs=1800 sinkQueuedMs=1000 queueDepth=0 pcmBytes=3200 audioMs=100 ja="次の文が始まります。"'),
    _l("11.510", "[chunk 3] PLAYED writtenBytes=3200 pcmBytes=3200 waitMs=0 backlogMs=1800 e2eFirstWordMs=4800 e2eLastWordMs=1800"),
]
class SentenceStartTest(unittest.TestCase):
    def test_starts_and_stages(self):
        p = rpt.parse_log(SENTENCE_LOG)
        chunks = list(p["chunks"].values())
        self.assertEqual([c["n"] for c in rpt.sentence_starts(chunks)], [1, 3])
        b = rpt.stage_breakdown(p["chunks"][3])
        self.assertEqual((b["span"], b["commitLag"], b["workerWait"], b["translate"], b["synth"], b["sinkWait"], b["total"]),
                         (3000, 500, 200, 100, 200, 800, 4800))
        self.assertAlmostEqual(sum(b[k] for k in rpt.STAGE_KEYS if k != "total"), b["total"])
    def test_metrics_and_report(self):
        m = rpt.metrics(rpt.parse_log(SENTENCE_LOG))
        self.assertEqual((m["sentenceStartCount"], m["sentenceStartLagAvgMs"], m["sentenceStartLagP50Ms"],
                          m["sentenceStartLagP90Ms"], m["sentenceStartLagMaxMs"]), (2, 4550, 4550, 4800, 4800))
        self.assertEqual(m["stagesSentenceStart"], dict(span=3000, commitLag=750, workerWait=100, translate=100,
                                                        synth=200, sinkWait=400, total=4550))
        self.assertEqual(m["stagesOther"]["span"], 2800)
        run = Path(tempfile.mkdtemp())
        text, built = rpt.build_report(run, {"label": "t", "mode": "local", "clipDurationSec": 30}, SENTENCE_LOG, [], {}, run)
        self.assertIn("## Sentence start lag", text)
        self.assertIn("| sentenceStartLagMs avg / median / p90 (sentences) | 4550 / 4550 / 4800 (2) |", text)
    def test_old_log_without_sink_field(self):
        m = rpt.metrics(rpt.parse_log(OLD_LOG.splitlines()))
        self.assertEqual(m["sentenceStartCount"], 0)
        self.assertEqual(m["stagesSentenceStart"], {})

if __name__ == "__main__":
    unittest.main()
