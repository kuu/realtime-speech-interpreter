"""Tests for the two-channel parts of the E2E reports (stdlib unittest). Synthetic log lines only.
Run: python3 -m unittest discover -s e2e/lib -p 'test_*.py'
"""
import json
import tempfile
import unittest
from pathlib import Path

import bilingual as bl
import report as rpt
import test_report as T

HERE = Path(__file__).resolve().parent
TS = "2026-11-12T06:{m:02d}:{s:02d}.{ms:03d}Z"


def ts(sec: float) -> str:
    whole = int(sec)
    return TS.format(m=whole // 60, s=whole % 60, ms=int(round((sec - whole) * 1000)))


def chunk_lines(n: int, ch: str, a0: float, a1: float, src: str, out: str, e2e_first: int, lag: int = 400, ja_source: bool = False) -> list[str]:
    """COMMIT, SYNTH and PLAYED lines of one chunk. t0 = 06:00:00.000, so the commit is at a1 + lag."""
    commit = a1 + lag / 1000
    sf, of = ("src", "out") if ja_source else ("en", "ja")
    return [
        f"{ts(commit)} INFO [chunk {n} ch={ch}] COMMIT reason={'clause' if ja_source else 'sentence'} mode={'simple' if ja_source else 'clause'} "
        f"words=9 result=r{n}{ch} audio={a0:.2f}-{a1:.2f}s commitLagMs={lag} queueDepth=1 {sf}=\"{src}\"",
        f"{ts(commit + 0.2)} INFO [chunk {n} ch={ch}] SYNTH translateMs=100 synthMs=100 rate=100 backlogMs=600 sinkQueuedMs=0 queueDepth=0 "
        f"pcmBytes=32000 audioMs=1000 {of}=\"{out}\"",
        f"{ts(commit + 0.5)} INFO [chunk {n} ch={ch}] PLAYED writtenBytes=32000 pcmBytes=32000 waitMs=0 backlogMs=1000 "
        f"e2eFirstWordMs={e2e_first} e2eLastWordMs={e2e_first - 2000}",
    ]


def two_lane_log() -> list[str]:
    L = [
        "2026-11-12T06:00:00.000Z INFO Simultaneous translation app starting",
        "2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream",
    ]
    L += chunk_lines(1, "ja", 0.5, 5.0, "Thank you for coming, everyone.", "皆さん、ありがとうございます。", 3000)
    L += chunk_lines(1, "en", 20.0, 23.0, "今日は晴れです、", "It is sunny today,", 4000, ja_source=True)
    L += chunk_lines(2, "en", 24.0, 26.0, "明日は雨です。", "Tomorrow it will rain.", 4200, ja_source=True)
    L += chunk_lines(2, "ja", 40.0, 45.0, "Next, the schedule.", "次に、スケジュールです。", 3100)
    L += chunk_lines(3, "en", 60.0, 64.0, "質問があります。", "I have a question.", 5000, ja_source=True)
    L += [
        "2026-11-12T06:01:10.000Z INFO [langfilter] ch=ja stream=1 results=4 kept=2 dropped=2 droppedWords=10 late=0 carried=0 repeats=0 lateSpoken=0",
        "2026-11-12T06:01:10.001Z INFO [langfilter] ch=en stream=1 results=4 kept=2 dropped=2 droppedWords=6 late=1 carried=0 repeats=0 lateSpoken=1",
        "2026-11-12T06:01:10.002Z INFO [summary] ch=en exit committed=3 played=3 dropped=0 skipped=0 failed=0",
    ]
    return L


class SplitTest(unittest.TestCase):
    def test_channels_and_legacy_rewrite(self):
        log = two_lane_log()
        self.assertTrue(bl.has_channels(log))
        self.assertEqual(bl.channels_in(log), ["ja", "en"])
        per = bl.split_channel_lines(log)
        en = "\n".join(per["en"])
        self.assertNotIn("ch=", en)
        self.assertIn('en="今日は晴れです、"', en, "src= is renamed to en= so the one-channel parser reads it")
        self.assertIn('ja="It is sunny today,"', en)
        self.assertNotIn("Thank you for coming", en, "the other channel's lines are not in this channel")
        self.assertIn("[session 1] first audio received", en, "shared lines are kept")

    def test_parse_log_works_on_each_channel(self):
        per = bl.split_channel_lines(two_lane_log())
        en = rpt.parse_log(per["en"])
        ja = rpt.parse_log(per["ja"])
        self.assertEqual([c["n"] for c in en["chunks"].values()], [1, 2, 3])
        self.assertEqual([c["n"] for c in ja["chunks"].values()], [1, 2])
        self.assertEqual(en["chunks"][3]["status"], "played")
        self.assertEqual(en["chunks"][1]["reason"], "clause")
        self.assertEqual(ja["chunks"][1]["en"], "Thank you for coming, everyone.")

    def test_main_lines(self):
        one = T.OLD_LOG.splitlines()
        self.assertIs(bl.main_lines(one), one, "a one-channel log passes through untouched")
        two = bl.main_lines(two_lane_log())
        self.assertIn("Thank you for coming", "\n".join(two))
        self.assertNotIn("今日は", "\n".join(two), "the main report is the first channel")
        only = [l.replace('en="', 'src="') for l in T.OLD_LOG.splitlines()]
        only = [l.replace("[chunk 1]", "[chunk 1]") for l in only]
        norm = bl.main_lines(only)
        self.assertIn(' en="Thank you', "\n".join(norm), "a Japanese-source single lane is read as the standard format")


class MetricsTest(unittest.TestCase):
    def test_channel_metrics(self):
        m = bl.channel_metrics(two_lane_log(), 120)
        self.assertEqual(list(m), ["ja", "en"])
        self.assertEqual((m["ja"]["chunks"], m["ja"]["played"]), (2, 2))
        self.assertEqual((m["en"]["chunks"], m["en"]["played"]), (3, 3))
        self.assertEqual(m["en"]["reasons"], {"clause": 3})
        self.assertEqual(m["ja"]["reasons"], {"sentence": 2})
        self.assertEqual(m["en"]["p50E2eFirstWordMs"], 4200)
        self.assertEqual(m["en"]["switches"], {"count": 1, "medianE2eFirstWordMs": 5000}, "chunk 3 follows a gap of 34 s")
        self.assertEqual(m["ja"]["switches"]["count"], 1)

    def test_routing_counts(self):
        r = bl.routing_counts(two_lane_log())
        self.assertEqual(r["ja"]["kept"], 2)
        self.assertEqual(r["en"]["dropped"], 2)
        self.assertEqual((r["en"]["late"], r["en"]["lateSpoken"]), (1, 1))
        self.assertEqual(r["ja"]["lateSpoken"], 0)
        # two streams add up
        again = two_lane_log() + [two_lane_log()[-3]]
        self.assertEqual(bl.routing_counts(again)["ja"]["results"], 8)

    def test_section_has_a_block_per_channel(self):
        text = "\n".join(bl.section(two_lane_log(), {}, 120))
        self.assertIn("## Channels (two-lane run)", text)
        self.assertIn("| Metric | `ja` | `en` |", text)
        self.assertIn("| Chunks | 2 | 3 |", text)
        self.assertIn("| Played | 2 | 3 |", text)
        self.assertIn("| `en` | 4 | 2 | 2 | 6 | 1 | 1 | 0 |", text)
        self.assertIn("### First chunk after a switch", text)


class ReportTest(unittest.TestCase):
    def _build(self, lines, meta=None):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run1"
            run.mkdir()
            m = dict(mode="local", label="golden", fileStem="rec", clipStartSec=0, clipDurationSec=60, startedAt="2026-11-12T06:00:00Z")
            m.update(meta or {})
            return rpt.build_report(run, m, lines, [], {}, Path(tmp))

    def test_one_channel_report_is_unchanged(self):
        text, _ = self._build(T.NEW_LOG.splitlines())
        golden = (HERE / "fixtures" / "onechannel-report.golden.md").read_text(encoding="utf-8")
        self.assertEqual(text, golden, "the one-channel report.md must not change (golden from the previous report.py)")
        self.assertNotIn("Channels (two-lane run)", text)

    def test_two_lane_report_has_the_channel_section(self):
        text, data = self._build(two_lane_log(), dict(clipDurationSec=120))
        self.assertIn("## Channels (two-lane run)", text)
        self.assertEqual(data["metrics"]["chunks"], 2, "the main metrics are the first channel")

    def test_japanese_only_note(self):
        text, _ = self._build(T.NEW_LOG.splitlines(), {"japaneseOnly": True})
        self.assertIn("Test mode: **Japanese only**", text)
        self.assertNotIn("Test mode", self._build(T.NEW_LOG.splitlines())[0])


class ScoringSheetTest(unittest.TestCase):
    def _many(self, n: int) -> list[str]:
        L = ["2026-11-12T06:00:00.000Z INFO [session 1] first audio received; opening Transcribe stream"]
        for i in range(1, n + 1):
            L += chunk_lines(i, "en", i * 3.0, i * 3.0 + 2, f"原文{i}です。", f"Translation {i}.", 3000 + i, ja_source=True)
        return L

    def test_thirty_evenly_chosen_chunks(self):
        ch, chosen = bl.scoring_chunks(self._many(90))
        self.assertEqual(ch, "en")
        self.assertEqual(len(chosen), 30)
        self.assertEqual([c["n"] for c in chosen][:3], [1, 4, 7], "every third chunk of 90")
        self.assertEqual(chosen[-1]["n"], 88)
        sheet = bl.scoring_sheet(self._many(90))
        self.assertIn("# Scoring sheet: channel `en`", sheet)
        self.assertIn("| 1 | 1 | 原文1です。 | Translation 1. |  |", sheet)
        self.assertIn("channel 1 minus 0.5", sheet.replace("\n", " "))
        self.assertEqual(sheet.count("\n| ") - 1, 30 + 0, "30 rows below the header row")

    def test_fewer_than_thirty_gives_all(self):
        self.assertEqual(len(bl.scoring_chunks(self._many(7))[1]), 7)

    def test_two_lane_log_uses_channel_en(self):
        ch, chosen = bl.scoring_chunks(two_lane_log())
        self.assertEqual((ch, [c["n"] for c in chosen]), ("en", [1, 2, 3]))
        self.assertIn("It is sunny today,", bl.scoring_sheet(two_lane_log()))


class CompareTest(unittest.TestCase):
    def _run(self, mode: str, reasons: list[str]) -> list[str]:
        L = []
        for i, r in enumerate(reasons, 1):
            L.append(f"{ts(5 + i)} INFO [chunk {i} ch=en] COMMIT reason={r} mode={mode} words=9 result=r{i} audio=0.50-{i}.00s "
                     f"commitLagMs=400 queueDepth=1 src=\"文{i}\"")
        return L

    def test_simple_and_full_side_by_side(self):
        a = self._run("simple", ["clause", "clause", "sentence", "maxwait"])
        b = self._run("full", ["ending", "sentence", "sentence", "pause", "maxchars"])
        text = bl.compare_section(a, b)
        self.assertIn("| Reason | A (mode simple) | B (mode full) |", text)
        self.assertIn("| clause | 2 | 0 |", text)
        self.assertIn("| sentence | 1 | 2 |", text)
        self.assertIn("| ending | 0 | 1 |", text)
        self.assertIn("| total | 4 | 5 |", text)

    def test_no_japanese_source_gives_nothing(self):
        self.assertEqual(bl.compare_section(T.OLD_LOG.splitlines(), T.NEW_LOG.splitlines()), "")


class RecorderNamesTest(unittest.TestCase):
    CONFIG = {"channels": [
        {"id": "ja", "sourceLang": "en", "targetLang": "ja", "track": "translation-audio", "publisher": "publisher-app", "topic": "captions"},
        {"id": "en", "sourceLang": "ja", "targetLang": "en", "track": "translation-audio-en", "publisher": "publisher-app-en", "topic": "captions-en"},
    ]}

    def test_file_names(self):
        self.assertEqual(bl.wav_name(None), "translation.wav")
        self.assertEqual(bl.wav_name("ja"), "translation-ja.wav")
        self.assertEqual(bl.wav_name("en"), "translation-en.wav")

    def test_listener_channels_only_for_two_or_more(self):
        self.assertEqual(len(bl.listener_channels(self.CONFIG)), 2)
        self.assertEqual(bl.listener_channels({"channels": self.CONFIG["channels"][:1]}), [])
        self.assertEqual(bl.listener_channels({"captions": True}), [])
        self.assertEqual(bl.listener_channels(None), [])
        self.assertEqual(bl.listener_channels({"channels": [{"id": 1}, {"id": 2}]}), [])

    def test_tracks_json_for_the_recorder(self):
        chans = bl.listener_channels(self.CONFIG)
        tracks = json.loads(bl.tracks_json(chans, {"ja": "/r/a.wav", "en": "/r/b.wav"}))
        self.assertEqual(tracks, [
            {"id": "ja", "publisher": "publisher-app", "track": "translation-audio", "out": "/r/a.wav"},
            {"id": "en", "publisher": "publisher-app-en", "track": "translation-audio-en", "out": "/r/b.wav"},
        ])

    def test_recorder_script_matches_by_publisher_and_track_name(self):
        src = (HERE / "recorder.cjs").read_text(encoding="utf-8")
        self.assertIn("t.publisher === participant.identity && t.track === pub.name", src)
        self.assertIn("tracksArg", src)
        self.assertIn('{ id: "", publisher: PUBLISHER, track: null, out: outFile }', src, "one channel keeps today's single recording")


if __name__ == "__main__":
    unittest.main()
