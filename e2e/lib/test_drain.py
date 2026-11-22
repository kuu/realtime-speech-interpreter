"""Tests for the drain decision of `e2e.sh run` (stdlib unittest). Synthetic log lines only."""
import unittest

import bilingual as bl
from test_report_bilingual import chunk_lines, ts

SESSION = 1


def lane_log(summaries: list[str], open_in: str | None = None) -> list[str]:
    L = ["2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream"]
    L += chunk_lines(1, "ja", 0.5, 5.0, "Hello everyone.", "synthetic one", 3000)
    L += chunk_lines(1, "en", 6.0, 8.0, "原文です。", "synthetic two", 4000, ja_source=True)
    if open_in:  # the same chunk number stays unfinished in one lane only
        L = [x for x in L if not (f"[chunk 1 ch={open_in}] PLAYED" in x)]
    for ch in summaries:
        L.append(f"{ts(30)} INFO [summary] ch={ch} session={SESSION} committed=1 played=1 dropped=0 skipped=0 failed=0")
    return L


class TwoLaneDrainTest(unittest.TestCase):
    def test_drained_when_both_summaries_and_all_chunks_final(self):
        ok, open_chunks = bl.drain_state(lane_log(["ja", "en"]), SESSION, ["ja", "en"])
        self.assertTrue(ok)
        self.assertEqual(open_chunks, [])

    def test_one_summary_missing_is_not_drained(self):
        ok, open_chunks = bl.drain_state(lane_log(["en"]), SESSION, ["ja", "en"])
        self.assertFalse(ok)
        self.assertEqual(open_chunks, [])

    def test_summary_of_a_lane_without_chunks_is_still_required(self):
        log = [x for x in lane_log(["ja"]) if "ch=en" not in x]
        self.assertFalse(bl.drain_state(log, SESSION, ["ja", "en"])[0])

    def test_same_chunk_number_open_in_one_lane_only(self):
        ok, open_chunks = bl.drain_state(lane_log(["ja", "en"], open_in="en"), SESSION, ["ja", "en"])
        self.assertTrue(ok)
        self.assertEqual(open_chunks, [("en", 1)], "chunk 1 of ja is final, chunk 1 of en is not")

    def test_lanes_default_to_those_seen_in_the_log(self):
        self.assertFalse(bl.drain_state(lane_log(["ja"]), SESSION)[0])
        self.assertTrue(bl.drain_state(lane_log(["ja", "en"]), SESSION)[0])

    def test_summary_of_another_session_does_not_count(self):
        log = lane_log([]) + [f"{ts(30)} INFO [summary] ch=ja session=2 committed=1", f"{ts(30)} INFO [summary] ch=en session=2 committed=1"]
        self.assertFalse(bl.drain_state(log, SESSION, ["ja", "en"])[0])


class OneLaneDrainTest(unittest.TestCase):
    def one(self, summary: bool, finish: bool) -> list[str]:
        L = ["2026-11-12T06:00:00.002Z INFO [session 1] first audio received; opening Transcribe stream"]
        c = chunk_lines(1, "ja", 0.5, 5.0, "Hello.", "synthetic", 3000)
        L += [x.replace(" ch=ja", "") for x in c]
        if not finish:
            L = [x for x in L if "PLAYED" not in x]
        if summary:
            L.append(f"{ts(30)} INFO [summary] session={SESSION} committed=1 played=1 dropped=0 skipped=0 failed=0")
        return L

    def test_untagged_summary_and_chunks(self):
        ok, open_chunks = bl.drain_state(self.one(True, True), SESSION)
        self.assertEqual((ok, open_chunks), (True, []))

    def test_no_summary(self):
        self.assertFalse(bl.drain_state(self.one(False, True), SESSION)[0])

    def test_open_chunk_is_listed_without_channel(self):
        ok, open_chunks = bl.drain_state(self.one(True, False), SESSION)
        self.assertTrue(ok)
        self.assertEqual(open_chunks, [("", 1)])

    def test_message_without_timestamp(self):
        self.assertTrue(bl.drain_state([f"[summary] session={SESSION} committed=1"], SESSION)[0])


if __name__ == "__main__":
    unittest.main()
