"""Tests for timings.py: python3 -m unittest discover -s .github/scripts"""

import os
import random
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from timings import fmt, median, percentile, pr_times, seconds, summarize  # noqa: E402


class Maths(unittest.TestCase):
    def test_worked_by_hand(self):
        # 1..10: p90 by nearest rank is the ceil(0.9 * 10) = 9th smallest, 9;
        # the median of an even count is the mean of the 5th and 6th, 5.5.
        values = [7, 3, 10, 1, 9, 2, 8, 4, 6, 5]
        self.assertEqual(percentile(values, 90), 9)
        self.assertEqual(median(values), 5.5)
        # Three values 60, 600, 61: sorted 60, 61, 600, median the middle one,
        # p90 rank ceil(2.7) = 3, the slowest; one slow run shows in p90, not the median.
        self.assertEqual(median([60, 600, 61]), 61)
        self.assertEqual(percentile([60, 600, 61], 90), 600)
        # 12:00:00 to 12:13:30 is 13 * 60 + 30 = 810 s.
        self.assertEqual(seconds("2026-10-23T12:00:00Z", "2026-10-23T12:13:30Z"), 810)
        self.assertEqual(fmt(810), "13m30s")
        self.assertEqual(fmt(3 * 3600 + 5 * 60), "3h05m")
        self.assertEqual(fmt(59), "59s")

    def test_edges(self):
        self.assertIsNone(percentile([], 90))
        self.assertIsNone(median([]))
        self.assertEqual(percentile([5], 90), 5)
        self.assertEqual(percentile([5, 1], 0), 1)  # rank never below 1
        self.assertIsNone(seconds(None, "2026-10-23T12:00:00Z"))
        # A finish before the start (clock trouble) is no time at all, not a negative one.
        self.assertIsNone(seconds("2026-10-23T12:00:01Z", "2026-10-23T12:00:00Z"))
        self.assertEqual(fmt(None), "-")

    def test_seeded_against_sorting_by_count(self):
        # A second way to the same percentile: the p-th value is the smallest v
        # with count(x <= v) >= p% of n, found by checking every candidate.
        rng = random.Random(20261024)
        for _ in range(500):
            values = [rng.randint(0, 50) for _ in range(rng.randint(1, 30))]
            p = rng.choice([50, 90, 95, 99, 100])
            want = min(v for v in values if sum(x <= v for x in values) * 100 >= p * len(values))
            self.assertEqual(percentile(values, p), want, (values, p))

    def test_summarize_drops_missing(self):
        out = summarize({"a": [None, 30, 10, 20], "b": [None], "c": []})
        self.assertEqual(out, {"a": dict(n=3, median=20, p90=30, max=30)})


class PullRequests(unittest.TestCase):
    PR = dict(created_at="2026-10-23T10:00:00Z", merged_at="2026-10-23T11:30:00Z")

    def test_worked_by_hand(self):
        # Opened as a draft at 10:00, ready at 11:00, queued at 11:10, merged at 11:30:
        # 90 min open, 30 min from ready, 20 min in the queue.
        events = [
            dict(event="committed"),
            dict(event="ready_for_review", created_at="2026-10-23T11:00:00Z"),
            dict(event="added_to_merge_queue", created_at="2026-10-23T11:10:00Z"),
        ]
        self.assertEqual(pr_times(self.PR, events), dict(worked=None, opened=5400, ready=1800, queue=1200))

    def test_opened_ready_and_requeued(self):
        # Opened ready: ready counts from opening. Never queued: no queue time.
        self.assertEqual(pr_times(self.PR, []), dict(worked=None, opened=5400, ready=5400, queue=None))
        # Dropped from the queue and queued again: the last entry counts (11:25 to 11:30).
        events = [
            dict(event="added_to_merge_queue", created_at="2026-10-23T11:00:00Z"),
            dict(event="removed_from_merge_queue", created_at="2026-10-23T11:05:00Z"),
            dict(event="added_to_merge_queue", created_at="2026-10-23T11:25:00Z"),
        ]
        self.assertEqual(pr_times(self.PR, events)["queue"], 300)

    def test_worked_from_earliest_commit(self):
        # Commits listed out of order, authored 09:40 and 09:15: work starts at
        # the earlier, 09:15, so 2 h 15 min = 8100 s to the 11:30 merge.
        commits = [
            dict(commit=dict(author=dict(date="2026-10-23T09:40:00Z"))),
            dict(commit=dict(author=dict(date="2026-10-23T09:15:00Z"))),
            dict(commit=dict(author=None)),
        ]
        self.assertEqual(pr_times(self.PR, [], commits)["worked"], 8100)


if __name__ == "__main__":
    unittest.main()
