"""Tests for automerge.py: python3 -m unittest discover -s .github/scripts"""

import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import automerge  # noqa: E402
from automerge import ci_state, decide  # noqa: E402


def pr(number, **kw):
    p = dict(number=number, head_ref=f"claude/t{number}", base_ref="main", same_repo=True,
             draft=False, labels=[], mergeable=True, up_to_date=True, ci="success",
             base_in_main=False)
    p.update(kw)
    return p


def check(name, status="completed", conclusion="success", app="github-actions"):
    return dict(name=name, status=status, conclusion=conclusion, app=dict(slug=app))


class CiState(unittest.TestCase):
    def test_cases(self):
        both = [check("kernel"), check("app")]
        self.assertEqual(ci_state(both), "success")
        self.assertEqual(ci_state([]), "none")
        # Only one of the two CI jobs has reported: not tested yet.
        self.assertEqual(ci_state([check("app")]), "none")
        self.assertEqual(ci_state(both + [check("app", "in_progress", None)]), "pending")
        self.assertEqual(ci_state([check("kernel"), check("app", conclusion="failure")]), "failure")
        self.assertEqual(ci_state([check("kernel"), check("app", conclusion="cancelled")]), "failure")
        # A check from another app that fails also blocks.
        # Another app's failing check blocks; one passing or skipped doesn't.
        self.assertEqual(ci_state(both + [check("lint", conclusion="failure", app="bot")]), "failure")
        self.assertEqual(ci_state(both + [check("x", conclusion="skipped", app="bot")]), "success")
        self.assertEqual(ci_state(both + [check("x", "queued", None, app="bot")]), "pending")
        # Other workflows of this repo don't count: random testing running for
        # hours on the branch, or this workflow's own run.
        self.assertEqual(ci_state(both + [check("test (0)", "in_progress", None),
                                          check("merge", conclusion="failure")]), "success")
        self.assertEqual(ci_state([check("test (0)")]), "none")


class HandWorked(unittest.TestCase):
    """Each case worked out from the rules in automerge.py's docstring."""

    def test_green_and_up_to_date_merges(self):
        self.assertEqual(decide([pr(5)]), ("merge", 5))

    def test_refusals(self):
        # Each breaks exactly one condition of an otherwise mergeable PR.
        for bad in (dict(draft=True), dict(labels=["hold"]), dict(base_ref="claude/x"),
                    dict(head_ref="feature/x"), dict(same_repo=False), dict(mergeable=False),
                    dict(mergeable=None), dict(ci="failure"), dict(ci="pending"),
                    dict(ci="none")):
            with self.subTest(bad=bad):
                self.assertNotEqual(decide([pr(5, **bad)]), ("merge", 5))

    def test_behind_main_is_updated_not_merged(self):
        # Green on its own, but main moved since: its test says nothing about
        # main plus it, so bring main in and test again.
        self.assertEqual(decide([pr(5, up_to_date=False)]), ("update", 5))

    def test_behind_and_red_is_left_to_its_thread(self):
        self.assertIsNone(decide([pr(5, up_to_date=False, ci="failure")]))
        self.assertIsNone(decide([pr(5, up_to_date=False, ci="pending")]))

    def test_one_in_the_queue_at_a_time(self):
        # #4 is being tested after an update; #5 is behind and green: it waits,
        # or both would be tested against a main that one of them changes.
        self.assertIsNone(decide([pr(4, ci="pending"), pr(5, up_to_date=False)]))
        # Oldest first.
        self.assertEqual(decide([pr(6, up_to_date=False), pr(5, up_to_date=False)]), ("update", 5))
        self.assertEqual(decide([pr(6), pr(5)]), ("merge", 5))
        # A ready merge is never held up by the queue.
        self.assertEqual(decide([pr(4, ci="pending"), pr(5)]), ("merge", 5))

    def test_untested_head_gets_tested(self):
        self.assertEqual(decide([pr(5, ci="none")]), ("test", 5))

    def test_stack(self):
        # #6 is stacked on #5's branch: it waits until #5's branch is in main,
        # then moves to main; it is never merged while on another base.
        parent, child = pr(5, up_to_date=False, ci="failure"), pr(6, base_ref="claude/t5")
        self.assertIsNone(decide([parent, child]))
        child["base_in_main"] = True
        self.assertEqual(decide([parent, child]), ("retarget", 6))
        # A base that isn't a Claude branch is never touched.
        self.assertIsNone(decide([pr(6, base_ref="release", base_in_main=True)]))


class Fake:
    """A fake GitHub API: answers from a table, records every write."""

    def __init__(self, table):
        self.table, self.writes = table, []

    def call(self, method, path, body=None):
        if method != "GET":
            self.writes.append((method, path, body))
            if path.endswith("/update-branch"):
                self.table["/pulls/1"]["head"]["sha"] = "new"
            return None
        return self.table[path]


def fake_repo(behind=False, ci="success"):
    raw = dict(number=1, draft=False, labels=[],
               head=dict(ref="claude/a", sha="h1", repo=dict(full_name="o/r")),
               base=dict(ref="main", repo=dict(full_name="o/r")))
    runs = [check("kernel"), check("app", conclusion=None if ci == "pending" else ci,
                                   status="in_progress" if ci == "pending" else "completed")]
    return Fake({
        "/pulls?state=open&per_page=100": [raw],
        "/pulls/1": dict(raw, mergeable=True, head=dict(raw["head"])),
        "/compare/main...h1": dict(status="diverged" if behind else "ahead"),
        "/commits/h1/check-runs?filter=latest&per_page=100": dict(check_runs=runs),
    })


class Calls(unittest.TestCase):
    def test_merge_pins_the_tested_head_then_deploys(self):
        gh = fake_repo()
        # After the merge the PR is gone from the open list.
        orig = gh.call

        def call(method, path, body=None):
            r = orig(method, path, body)
            if method == "PUT":
                gh.table["/pulls?state=open&per_page=100"] = []
            return r
        gh.call = call
        self.assertEqual(automerge.run(gh, log=lambda s: None), 1)
        self.assertEqual(gh.writes, [
            ("PUT", "/pulls/1/merge", {"merge_method": "merge", "sha": "h1"}),
            ("POST", "/actions/workflows/pages.yml/dispatches", {"ref": "main"}),
        ])

    def test_update_then_ci_started_no_deploy(self):
        gh = fake_repo(behind=True)
        self.assertEqual(automerge.run(gh, log=lambda s: None), 0)
        self.assertEqual(gh.writes, [
            ("PUT", "/pulls/1/update-branch", {"expected_head_sha": "h1"}),
            ("POST", "/actions/workflows/ci.yml/dispatches", {"ref": "claude/a"}),
        ])

    def test_dry_run_writes_nothing(self):
        gh = fake_repo()
        automerge.run(gh, dry_run=True, log=lambda s: None)
        self.assertEqual(gh.writes, [])


class Simulation(unittest.TestCase):
    """Random sessions against a simple model of git and CI.

    A commit is the set of changes it holds; a branch contains main when
    main's set is a subset of its own. CI on a set is red when it holds a
    "bad" change or both changes of a "clash" (two changes that pass alone
    but break together). Safety: main is only ever a set that CI tested green
    (so it never holds a bad change or a clash). Liveness: when the threads go
    quiet, every PR still open is a draft, held, conflicting, red, or stacked
    on an open PR.
    """

    SEEDS = (1, 2, 3, 4, 5)
    STEPS = 2000

    def test_sessions(self):
        for seed in self.SEEDS:
            with self.subTest(seed=seed):
                Session(seed, self).play(self.STEPS)


class Session:
    def __init__(self, seed, t):
        self.rng, self.t = random.Random(seed), t
        self.main, self.next_change = frozenset(), 0
        self.branches, self.prs, self.ci = {}, {}, {}
        self.bad, self.clashes, self.next_pr = set(), [], 1
        self.green_mains = {frozenset()}
        self.merges = 0

    def change(self):
        c = self.next_change
        self.next_change += 1
        roll = self.rng.random()
        if roll < 0.1:
            self.bad.add(c)
        elif roll < 0.25 and c > 0:
            self.clashes.append((self.rng.randrange(c), c))
        return c

    def green(self, content):
        return not (content & self.bad) and not any(a in content and b in content for a, b in self.clashes)

    def view(self):
        out = []
        for n, p in self.prs.items():
            head = self.branches[p["head_ref"]]
            base_in_main = p["base_ref"] in self.branches and self.branches[p["base_ref"]] <= self.main
            out.append(dict(number=n, head_ref=p["head_ref"], base_ref=p["base_ref"], same_repo=True,
                            draft=p["draft"], labels=p["labels"], mergeable=p["mergeable"],
                            up_to_date=self.main <= head, ci=self.ci.get(head, "none"),
                            base_in_main=base_in_main))
        return out

    def automate(self):
        for _ in range(50):
            action = decide(self.view())
            if action is None:
                return
            kind, n = action
            p = self.prs[n]
            head = self.branches[p["head_ref"]]
            if kind == "retarget":
                p["base_ref"] = "main"
            elif kind == "merge":
                t = self.t
                t.assertEqual(p["base_ref"], "main")
                t.assertTrue(self.main <= head, "merged a branch that is behind main")
                t.assertEqual(self.ci.get(head), "success", "merged an untested head")
                t.assertFalse(p["draft"] or "hold" in p["labels"])
                self.main = head
                t.assertIn(self.main, self.green_mains, "main holds a set CI never passed")
                del self.prs[n]
                self.merges += 1
            elif kind in ("update", "test"):
                if kind == "update":
                    self.branches[p["head_ref"]] = head | self.main
                self.ci.setdefault(self.branches[p["head_ref"]], "pending")
                return  # waits for CI, as the workflow does
        self.t.fail("automation did not settle")

    def push(self, ref, content):
        self.branches[ref] = content
        self.ci.setdefault(content, "pending")

    def event(self):
        rng = self.rng
        roll = rng.random()
        open_prs = list(self.prs.values())
        if roll < 0.15 or not open_prs:
            n = self.next_pr
            self.next_pr += 1
            ref = f"claude/b{n}"
            stack_on = rng.choice(open_prs) if open_prs and rng.random() < 0.2 else None
            base = self.branches[stack_on["head_ref"]] if stack_on else self.main
            self.push(ref, base | {self.change()})
            self.prs[n] = dict(head_ref=ref, base_ref=stack_on["head_ref"] if stack_on else "main",
                               draft=rng.random() < 0.2, labels=["hold"] if rng.random() < 0.05 else [],
                               mergeable=rng.random() > 0.05)
        elif roll < 0.35:
            p = rng.choice(open_prs)
            self.push(p["head_ref"], self.branches[p["head_ref"]] | {self.change()})
        elif roll < 0.45:
            rng.choice(open_prs)["draft"] = False
        elif roll < 0.5:
            p = rng.choice(open_prs)
            p["labels"] = []
            p["mergeable"] = True
        else:
            pending = [c for c, s in self.ci.items() if s == "pending"]
            if pending:
                c = rng.choice(pending)
                self.ci[c] = "success" if self.green(c) else "failure"
                if self.ci[c] == "success":
                    self.green_mains.add(c)

    def play(self, steps):
        for _ in range(steps):
            self.event()
            self.automate()
        # The threads go quiet: CI finishes, automation runs to the end.
        for _ in range(10 * steps):
            pending = [c for c, s in self.ci.items() if s == "pending"]
            if not pending:
                break
            for c in pending:
                self.ci[c] = "success" if self.green(c) else "failure"
                if self.ci[c] == "success":
                    self.green_mains.add(c)
            self.automate()
        self.t.assertGreater(self.merges, 20, "too few merges to mean anything")
        for n, p in self.prs.items():
            head = self.branches[p["head_ref"]]
            stuck_ok = (p["draft"] or p["labels"] or not p["mergeable"]
                        or not self.green(head | self.main)
                        or (p["base_ref"] != "main" and not self.branches[p["base_ref"]] <= self.main))
            self.t.assertTrue(stuck_ok, f"#{n} could merge but was left open")


if __name__ == "__main__":
    unittest.main()
