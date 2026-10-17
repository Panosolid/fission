"""Tests for stop-on-merge.sh and endless.sh's stop file:
python3 -m unittest discover -s .github/scripts

Both run for real, with fake `gh` and `cargo` programs first on PATH."""

import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
WATCHER = os.path.join(HERE, "stop-on-merge.sh")
ENDLESS = os.path.join(REPO, "kernel", "scripts", "endless.sh")


def fake(bin_dir, name, body):
    path = os.path.join(bin_dir, name)
    with open(path, "w") as f:
        f.write("#!/usr/bin/env bash\n" + body)
    os.chmod(path, 0o755)


class Watcher(unittest.TestCase):
    """stop-on-merge.sh with a fake `gh` that prints the given PR states, one per line."""

    def watch(self, gh_body, seconds=1.0):
        with tempfile.TemporaryDirectory() as d:
            fake(d, "gh", gh_body)
            stop = os.path.join(d, "stop")
            env = dict(os.environ, PATH=d + os.pathsep + os.environ["PATH"], STOP_POLL_SECONDS="0.05", GITHUB_REPOSITORY="o/r")
            try:
                out = subprocess.run(["bash", WATCHER, "claude/x", stop], env=env, capture_output=True, text=True, timeout=seconds)
                stopped = True
            except subprocess.TimeoutExpired as e:
                out, stopped = e, False
            return stopped, os.path.exists(stop), out

    def test_merged_or_closed_stops(self):
        for states in ("MERGED", "CLOSED", "MERGED\\nCLOSED"):
            stopped, made, out = self.watch(f'printf "{states}\\n"')
            self.assertTrue(stopped and made, states)
            self.assertIn("has merged or closed", out.stdout)

    def test_open_or_no_pull_request_keeps_testing(self):
        # No PR yet (empty answer), one open, or an old one closed and a new
        # one open: the branch is still live, so the watcher never stops.
        for body in ("true", 'printf "OPEN\\n"', 'printf "CLOSED\\nOPEN\\n"'):
            stopped, made, _ = self.watch(body)
            self.assertFalse(stopped or made, body)

    def test_a_failed_lookup_waits_for_the_next_one(self):
        # The first two answers fail, the third says merged.
        with tempfile.TemporaryDirectory() as count:
            n = os.path.join(count, "n")
            body = f'echo x >>{n}; [ $(wc -l <{n}) -ge 3 ] || exit 1; echo MERGED\n'
            stopped, made, _ = self.watch(body, seconds=5)
            self.assertTrue(stopped and made)
            with open(n) as f:
                self.assertEqual(len(f.read().split()), 3)

    def test_it_asks_about_this_branch(self):
        with tempfile.TemporaryDirectory() as log:
            args = os.path.join(log, "args")
            stopped, _, _ = self.watch(f'echo "$@" >{args}; echo MERGED\n')
            self.assertTrue(stopped)
            with open(args) as f:
                self.assertIn("--repo o/r --head claude/x --state all", f.read())


class EndlessStopFile(unittest.TestCase):
    """endless.sh in a scratch copy of kernel/: a fake `cargo` stands in for
    the build and the harness (each round takes 0.3 s and passes)."""

    def run_endless(self, rounds, touch_in_round=None, stop_file=True):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "kernel", "scripts"))
            shutil.copy(ENDLESS, os.path.join(d, "kernel", "scripts"))
            bin_dir = os.path.join(d, "bin")
            os.mkdir(bin_dir)
            stop = os.path.join(d, "stop")
            calls = os.path.join(d, "calls")
            # Round k is the k-th harness call (the build has --no-run).
            touch = f'[ $(grep -c . {calls}) = {touch_in_round} ] && touch {stop}\n' if touch_in_round else ""
            fake(bin_dir, "cargo", f'case "$*" in *--no-run*) exit 0;; esac\necho r >>{calls}\n{touch}sleep 0.3\n')
            env = dict(os.environ, PATH=bin_dir + os.pathsep + os.environ["PATH"])
            env.pop("FISSION_ENDLESS_STOP_FILE", None)
            if stop_file:
                env["FISSION_ENDLESS_STOP_FILE"] = stop
            out = subprocess.run(["bash", os.path.join(d, "kernel", "scripts", "endless.sh"), "10", str(rounds), "false"],
                                 env=env, capture_output=True, text=True, timeout=60)
            with open(os.path.join(d, "kernel", "endless-results", "log.csv")) as f:
                logged = f.read().splitlines()[1:]
            return out, logged

    def test_the_round_in_progress_is_kept_and_no_new_one_starts(self):
        # The stop file appears during round 2 of up to 5: rounds 1 and 2 are
        # logged as passes (round 2 is not thrown away), round 3 never starts.
        out, logged = self.run_endless(5, touch_in_round=2)
        self.assertEqual([line.split(",")[3] for line in logged], ["pass", "pass"])
        self.assertIn("Stopped after 2 rounds", out.stdout)
        self.assertNotIn("discarded", out.stdout)

    def test_without_the_file_every_round_runs(self):
        # Same script, nothing appears: all 3 rounds run (so the test above
        # can tell a stop from a normal end).
        _, logged = self.run_endless(3)
        self.assertEqual(len(logged), 3)

    def test_the_file_is_ignored_unless_named(self):
        # The file appears in round 1 but FISSION_ENDLESS_STOP_FILE is unset
        # (a run on the owner's computer): all 3 rounds run.
        _, logged = self.run_endless(3, touch_in_round=1, stop_file=False)
        self.assertEqual(len(logged), 3)


if __name__ == "__main__":
    unittest.main()
