"""Tests for automerge.py: python3 -m unittest discover -s .github/scripts"""

import io
import os
import random
import urllib.error
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import automerge  # noqa: E402
from automerge import ci_state, decide, decide_queue  # noqa: E402


def pr(number, **kw):
    p = dict(number=number, head_ref=f"claude/t{number}", base_ref="main", same_repo=True,
             draft=False, labels=[], mergeable=True, up_to_date=True, ci="success",
             base_in_main=False, asked=False)
    p.update(kw)
    return p


def check(name, status="completed", conclusion="success", app="github-actions"):
    return dict(name=name, status=status, conclusion=conclusion, app=dict(slug=app))


class CiState(unittest.TestCase):
    def test_cases(self):
        both = [check("kernel"), check("app"), check("e2e"), check("mutants-in-diff"), check("baseline")]
        self.assertEqual(ci_state(both), "success")
        self.assertEqual(ci_state([]), "none")
        # Only one of the two CI jobs has reported: not tested yet.
        self.assertEqual(ci_state([check("app")]), "none")
        self.assertEqual(ci_state(both + [check("app", "in_progress", None)]), "pending")
        self.assertEqual(ci_state([check("kernel"), check("app", conclusion="failure")]), "failure")
        self.assertEqual(ci_state([check("kernel"), check("app", conclusion="cancelled")]), "failure")
        # Mutation survivors in the changed kernel code block the merge; a
        # head the mutation job never ran on has not been tested.
        self.assertEqual(ci_state([check("kernel"), check("app"), check("e2e"), check("baseline"), check("mutants-in-diff", conclusion="failure")]),
                         "failure")
        # So do a slowdown or memory growth past tests/baseline.json's margins;
        # a head without the baseline job (a branch from before it) is untested.
        self.assertEqual(ci_state([check("kernel"), check("app"), check("e2e"), check("mutants-in-diff"), check("baseline", conclusion="failure")]),
                         "failure")
        self.assertEqual(ci_state([check("kernel"), check("app"), check("e2e"), check("mutants-in-diff")]), "none")
        self.assertEqual(ci_state([check("kernel"), check("app")]), "none")
        # The browser checks run in shares beside app; their gate job e2e
        # blocks when any share failed, and a head from before the split (no
        # e2e check) is untested.
        rest = [check("kernel"), check("app"), check("mutants-in-diff"), check("baseline")]
        self.assertEqual(ci_state(rest), "none")
        self.assertEqual(ci_state(rest + [check("e2e", conclusion="failure")]), "failure")
        self.assertEqual(ci_state(rest + [check("e2e", "queued", None)]), "pending")
        # The gate job only appears once every share has finished, so while
        # a share still runs the head is being tested, not untested: "none"
        # there would start a second run that cancels this one, over and over.
        self.assertEqual(ci_state(rest + [check("e2e (1/3)"), check("e2e (2/3)", "in_progress", None)]), "pending")
        self.assertEqual(ci_state(rest + [check("e2e (1/3)", conclusion="failure"), check("e2e (2/3)")]), "failure")
        self.assertEqual(ci_state(rest + [check("e2e (1/3)"), check("e2e (2/3)"), check("e2e")]), "success")
        # The same for the mutation shards under mutants-in-diff, which can run
        # long after kernel and app are done.
        self.assertEqual(ci_state([check("kernel"), check("app"), check("e2e"), check("baseline"),
                                   check("mutants-shard (0)", "in_progress", None)]), "pending")
        self.assertEqual(ci_state([check("kernel"), check("app"), check("e2e"), check("baseline"),
                                   check("mutants-shard (0)", conclusion="failure")]), "failure")
        # Other matrix jobs still don't count: CI's browsers (reported only)
        # and the nightly fuzzing's kernel targets, whatever their name starts with.
        self.assertEqual(ci_state(both + [check("browsers (firefox)", "in_progress", None),
                                          check("kernel (extrude)", conclusion="failure")]), "success")
        # On a push run the job is skipped, which passes; the coverage
        # report never blocks.
        self.assertEqual(ci_state(both + [check("mutants-in-diff", conclusion="skipped"),
                                          check("coverage", conclusion="failure")]), "success")
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
                    dict(ci="none"), dict(up_to_date=False)):
            with self.subTest(bad=bad):
                self.assertNotEqual(decide([pr(5, **bad)]), ("merge", 5))

    def test_behind_main_asks_its_thread_once(self):
        # Green on its own, but main moved since: its test says nothing about
        # main plus it, so its thread is asked to bring main in (a push the
        # ruleset counts); once asked for this head and main, it waits.
        self.assertEqual(decide([pr(5, up_to_date=False)]), ("ask", 5))
        self.assertIsNone(decide([pr(5, up_to_date=False, asked=True)]))
        # A conflicted or not-yet-known merge isn't asked: the conflict reminder covers it.
        self.assertIsNone(decide([pr(5, up_to_date=False, mergeable=None)]))

    def test_behind_and_red_is_left_to_its_thread(self):
        self.assertIsNone(decide([pr(5, up_to_date=False, ci="failure")]))
        self.assertIsNone(decide([pr(5, up_to_date=False, ci="pending")]))

    def test_one_in_the_queue_at_a_time(self):
        # #4 is being tested after an update; #5 is behind and green: it waits,
        # or both would be tested against a main that one of them changes.
        self.assertIsNone(decide([pr(4, ci="pending"), pr(5, up_to_date=False)]))
        # Oldest first; an asked one doesn't hold up the next.
        self.assertEqual(decide([pr(6, up_to_date=False), pr(5, up_to_date=False)]), ("ask", 5))
        self.assertEqual(decide([pr(6, up_to_date=False), pr(5, up_to_date=False, asked=True)]), ("ask", 6))
        self.assertEqual(decide([pr(6), pr(5)]), ("merge", 5))
        # A ready merge is never held up by the queue.
        self.assertEqual(decide([pr(4, ci="pending"), pr(5)]), ("merge", 5))

    def test_untested_head_waits_for_its_own_run(self):
        # Auto-merge never starts CI itself (a run it starts doesn't count for
        # main's ruleset): a head with no checks yet waits for its push's run.
        self.assertIsNone(decide([pr(5, ci="none")]))

    def test_skipped_ones_are_left_alone(self):
        # #5's merge was refused earlier in this run: #6 merges, #5 is not tried again.
        self.assertEqual(decide([pr(5), pr(6)], skip={5}), ("merge", 6))
        self.assertIsNone(decide([pr(5)], skip={5}))

    def test_stack(self):
        # #6 is stacked on #5's branch: it waits until #5's branch is in main,
        # then moves to main; it is never merged while on another base.
        parent, child = pr(5, up_to_date=False, ci="failure"), pr(6, base_ref="claude/t5")
        self.assertIsNone(decide([parent, child]))
        child["base_in_main"] = True
        self.assertEqual(decide([parent, child]), ("retarget", 6))
        # A base that isn't a Claude branch is never touched.
        self.assertIsNone(decide([pr(6, base_ref="release", base_in_main=True)]))


# main's rules as the API lists them: today's (no merge queue), and with the queue.
OLD_RULES = [dict(type="deletion"), dict(type="pull_request"), dict(type="required_status_checks")]
QUEUE_RULES = OLD_RULES + [dict(type="merge_queue")]


class Fake:
    """A fake GitHub API: answers from a table, records every write."""

    def __init__(self, table):
        self.table, self.writes = table, []

    def call(self, method, path, body=None):
        if method != "GET":
            self.writes.append((method, path, body))
            return None
        return self.table[path]


def fake_repo(behind=False, ci="success"):
    raw = dict(number=1, draft=False, labels=[],
               head=dict(ref="claude/a", sha="h1", repo=dict(full_name="o/r")),
               base=dict(ref="main", repo=dict(full_name="o/r")))
    runs = [check("kernel"), check("e2e"), check("mutants-in-diff"), check("baseline"), check("app", conclusion=None if ci == "pending" else ci,
                                   status="in_progress" if ci == "pending" else "completed")]
    return Fake({
        "/rules/branches/main": OLD_RULES,
        "/pulls?state=open&per_page=100": [raw],
        "/pulls/1": dict(raw, mergeable=True, head=dict(raw["head"])),
        "/compare/main...h1": dict(status="diverged" if behind else "ahead"),
        "/commits/h1/check-runs?filter=latest&per_page=100": dict(check_runs=runs),
        "/commits/main": dict(sha="m1"),
        "/issues/1/comments?per_page=100": [],
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

    def test_behind_asks_once_pushes_nothing_starts_nothing(self):
        gh = fake_repo(behind=True)
        orig = gh.call

        def call(method, path, body=None):
            r = orig(method, path, body)
            if method == "POST" and path == "/issues/1/comments":
                gh.table["/issues/1/comments?per_page=100"] = [body]
            return r
        gh.call = call
        self.assertEqual(automerge.run(gh, log=lambda s: None), 0)
        self.assertEqual(len(gh.writes), 1)
        method, path, body = gh.writes[0]
        self.assertEqual((method, path), ("POST", "/issues/1/comments"))
        self.assertIn("<!-- automerge-behind:h1:m1 -->", body["body"])
        self.assertIn("merge `main` into it", body["body"])
        # The next run finds the comment for this head and main: nothing more.
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(len(gh.writes), 1)
        # main moves on (m2): asked again, once.
        gh.table["/commits/main"] = dict(sha="m2")
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(len(gh.writes), 2)
        self.assertIn("<!-- automerge-behind:h1:m2 -->", gh.writes[1][2]["body"])

    def test_a_refused_merge_is_skipped_and_the_next_one_merges(self):
        # The 2026-10-18 jam: #1's merge refused (405, a rule), and the run
        # stopped there, so #2, green and up to date, never merged.
        gh = fake_repo()
        raw2 = dict(gh.table["/pulls?state=open&per_page=100"][0], number=2,
                    head=dict(ref="claude/b", sha="h2", repo=dict(full_name="o/r")))
        gh.table["/pulls?state=open&per_page=100"].append(raw2)
        gh.table["/pulls/2"] = dict(raw2, mergeable=True)
        gh.table["/compare/main...h2"] = dict(status="ahead")
        gh.table["/commits/h2/check-runs?filter=latest&per_page=100"] = gh.table["/commits/h1/check-runs?filter=latest&per_page=100"]
        orig = gh.call

        def call(method, path, body=None):
            if (method, path) == ("PUT", "/pulls/1/merge"):
                gh.writes.append((method, path, body))
                raise urllib.error.HTTPError(path, 405, "Method Not Allowed", {}, io.BytesIO(b'{"message":"5 of 5 required status checks are expected."}'))
            r = orig(method, path, body)
            if (method, path) == ("PUT", "/pulls/2/merge"):
                gh.table["/pulls?state=open&per_page=100"] = [p for p in gh.table["/pulls?state=open&per_page=100"] if p["number"] != 2]
            return r
        gh.call = call
        logs = []
        self.assertEqual(automerge.run(gh, log=logs.append), 1)
        self.assertEqual(gh.writes, [
            ("PUT", "/pulls/1/merge", {"merge_method": "merge", "sha": "h1"}),
            ("PUT", "/pulls/2/merge", {"merge_method": "merge", "sha": "h2"}),
            ("POST", "/actions/workflows/pages.yml/dispatches", {"ref": "main"}),
        ])
        self.assertTrue(any("405" in line and "required status checks" in line for line in logs))

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
        self.asked = set()  # (pr, head, main) its thread was asked to merge main into
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
                            base_in_main=base_in_main, asked=(n, head, self.main) in self.asked))
        return out

    def automate(self):
        for _ in range(500):
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
            elif kind == "ask":
                self.t.assertFalse((n, head, self.main) in self.asked, "asked twice for the same head and main")
                self.asked.add((n, head, self.main))
        self.t.fail("automation did not settle")

    def answer(self, n):
        """Its thread answers an ask: merges main in and pushes (a push the ruleset counts)."""
        p = self.prs[n]
        self.push(p["head_ref"], self.branches[p["head_ref"]] | self.main)

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
        elif roll < 0.6:
            waiting = sorted({n for n, _, _ in self.asked if n in self.prs})
            if waiting:
                self.answer(rng.choice(waiting))
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
        # The threads stop starting work: CI finishes, each ask is answered,
        # automation runs to the end.
        for _ in range(10 * steps):
            pending = [c for c, s in self.ci.items() if s == "pending"]
            waiting = [n for n, p in self.prs.items() if (n, self.branches[p["head_ref"]], self.main) in self.asked]
            if not pending and not waiting:
                break
            for n in waiting:
                self.answer(n)
            pending = [c for c, s in self.ci.items() if s == "pending"]
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


GRACE = automerge.CONFLICT_GRACE_S


def conflicted(**kw):
    p = pr(7, mergeable=False, head_sha="c7", head_time=1000, reminded=False)
    p.update(kw)
    return p


class ConflictReminder(unittest.TestCase):
    """When a conflicted pull request gets its one reminder."""

    def test_hand_worked(self):
        # Head pushed at t=1000, main last moved at t=1600: neither side has
        # changed since 1600, so at t=1600+900=2500 the conflict is at least
        # 15 minutes (900 s) old: remind. Main's time decides here, not the
        # head's, because it is the later of the two.
        self.assertTrue(automerge.needs_reminder(conflicted(), 1600, 2500))
        self.assertFalse(automerge.needs_reminder(conflicted(), 1600, 2499))
        # Head pushed after main moved: the push restarts the wait.
        self.assertFalse(automerge.needs_reminder(conflicted(head_time=2000), 1600, 2500))

    def test_boundaries(self):
        # 0.9 x the grace: too soon; 1.1 x: remind.
        self.assertFalse(automerge.needs_reminder(conflicted(), 0, 1000 + 0.9 * GRACE))
        self.assertTrue(automerge.needs_reminder(conflicted(), 0, 1000 + 1.1 * GRACE))

    def test_refusals(self):
        late = 1000 + 10 * GRACE
        for bad in (dict(draft=True), dict(mergeable=True), dict(mergeable=None), dict(reminded=True)):
            with self.subTest(bad=bad):
                self.assertFalse(automerge.needs_reminder(conflicted(**bad), 0, late))

    def test_text(self):
        text = automerge.reminder_text(conflicted(), ["packages/ui/src/theme.css", "CLAUDE.md"])
        self.assertIn("- `packages/ui/src/theme.css`\n- `CLAUDE.md`", text)
        self.assertIn("<!-- automerge-conflict:c7 -->", text)
        self.assertTrue(text.endswith("---\n_Generated by [Claude Code](https://claude.ai/code)_"))
        self.assertIn("could not list them", automerge.reminder_text(conflicted(), []))

    def test_iso_seconds(self):
        # 1970-01-02T00:00:15Z is one day and 15 s after the epoch: 86415.
        self.assertEqual(automerge.iso_seconds("1970-01-02T00:00:15Z"), 86415)


def conflict_repo(comments=()):
    raw = dict(number=7, draft=False, labels=[],
               head=dict(ref="claude/c", sha="c7", repo=dict(full_name="o/r")),
               base=dict(ref="main", repo=dict(full_name="o/r")))
    stamp = lambda s: dict(commit=dict(committer=dict(date=s)))
    return Fake({
        "/rules/branches/main": OLD_RULES,
        "/pulls?state=open&per_page=100": [raw],
        "/pulls/7": dict(raw, mergeable=False),
        "/compare/main...c7": dict(status="diverged"),
        "/commits/c7/check-runs?filter=latest&per_page=100": dict(check_runs=[check("kernel"), check("app")]),
        "/commits/c7": stamp("1970-01-01T00:10:00Z"),     # 600 s
        "/commits/main": dict(stamp("1970-01-01T00:20:00Z"), sha="m1"),   # 1200 s
        "/issues/7/comments?per_page=100": [dict(body=b) for b in comments],
    })


class ConflictCalls(unittest.TestCase):
    files = staticmethod(lambda ref: ["a.txt"])

    def run_at(self, gh, now, dry_run=False):
        return automerge.run(gh, dry_run=dry_run, log=lambda s: None, now=now, files_for=self.files)

    def test_posts_once_with_files(self):
        gh = conflict_repo()
        self.run_at(gh, 1200 + GRACE - 1)  # main moved at 1200: too soon
        self.assertEqual(gh.writes, [])
        self.run_at(gh, 1200 + GRACE)
        self.assertEqual(len(gh.writes), 1)
        method, path, body = gh.writes[0]
        self.assertEqual((method, path), ("POST", "/issues/7/comments"))
        self.assertIn("- `a.txt`", body["body"])
        self.assertIn("<!-- automerge-conflict:c7 -->", body["body"])

    def test_not_again_for_the_same_head(self):
        gh = conflict_repo(comments=["hi", "x <!-- automerge-conflict:c7 --> y"])
        self.run_at(gh, 10 * GRACE)
        self.assertEqual(gh.writes, [])

    def test_again_for_a_new_head(self):
        gh = conflict_repo(comments=["<!-- automerge-conflict:old -->"])
        self.run_at(gh, 10 * GRACE)
        self.assertEqual(len(gh.writes), 1)

    def test_dry_run_posts_nothing(self):
        gh = conflict_repo()
        self.run_at(gh, 10 * GRACE, dry_run=True)
        self.assertEqual(gh.writes, [])


class ConflictedFiles(unittest.TestCase):
    """conflicted_files against a real git repository."""

    def test_real_merge(self):
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            def git(*a):
                subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)

            def write(name, text):
                with open(os.path.join(d, name), "w") as f:
                    f.write(text)
            git("init", "-q", "-b", "main")
            git("config", "user.email", "t@t"); git("config", "user.name", "t")
            for n in ("both.txt", "mine.txt", "theirs.txt"):
                write(n, "base\n")
            git("add", "."); git("commit", "-qm", "base")
            git("checkout", "-qb", "claude/x")
            write("both.txt", "branch\n"); write("mine.txt", "branch\n")
            git("commit", "-qam", "branch")
            git("checkout", "-q", "main")
            write("both.txt", "main\n"); write("theirs.txt", "main\n")
            git("commit", "-qam", "main")
            # The workflow reads origin/... refs; point them at the local ones.
            git("update-ref", "refs/remotes/origin/main", "main")
            git("update-ref", "refs/remotes/origin/claude/x", "claude/x")
            cwd = os.getcwd()
            os.chdir(d)
            try:
                # Only both.txt changed on both sides: the one conflict.
                self.assertEqual(automerge.conflicted_files("claude/x"), ["both.txt"])
                # A clean merge (the branch against itself) lists nothing.
                git("update-ref", "refs/remotes/origin/main", "claude/x")
                self.assertEqual(automerge.conflicted_files("claude/x"), [])
                # An unknown branch: git fails, nothing listed, no crash.
                self.assertEqual(automerge.conflicted_files("claude/none"), [])
            finally:
                os.chdir(cwd)


class ConflictSimulation(unittest.TestCase):
    """Seeded random timelines against a model that knows when each conflict
    really started: never a reminder before 15 minutes of conflict, at most
    one per head, and one always comes once nothing has changed for the
    grace plus one run interval."""

    def test_timelines(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                now, main_time, head_time, sha = 0, 0, 0, 0
                conflict_since, reminded = None, set()
                for _ in range(2000):
                    now += rng.choice((60, 300, 600, 1800))
                    roll = rng.random()
                    if roll < 0.15:  # the thread pushes: new head, maybe fixed
                        sha, head_time = sha + 1, now
                        conflict_since = now if rng.random() < 0.5 else None
                    elif roll < 0.3:  # main moves: may start a conflict
                        main_time = now
                        if conflict_since is None and rng.random() < 0.4:
                            conflict_since = now
                    p = conflicted(head_sha=f"s{sha}", head_time=head_time,
                                   mergeable=conflict_since is None and True or False,
                                   reminded=f"s{sha}" in reminded)
                    if automerge.needs_reminder(p, main_time, now):
                        self.assertIsNotNone(conflict_since)
                        self.assertGreaterEqual(now - conflict_since, GRACE)
                        reminded.add(f"s{sha}")
                    elif (conflict_since is not None and f"s{sha}" not in reminded
                          and now - max(main_time, head_time) >= GRACE):
                        self.fail("a conflict unchanged for the grace got no reminder")


def qpr(number, **kw):
    """A pull request as decide_queue sees it."""
    return pr(number, **dict(dict(queued=False, dequeued=False), **kw))


class QueueHandWorked(unittest.TestCase):
    """decide_queue, each case worked out from automerge.py's docstring."""

    def test_ready_ones_are_queued(self):
        # Ready, no hold, targets main, never removed by the queue: merge when ready.
        self.assertEqual(decide_queue([qpr(5)]), ("enable", 5))
        # Already queued: nothing to do.
        self.assertIsNone(decide_queue([qpr(5, queued=True)]))
        # Its own checks don't matter here: GitHub waits for them before queueing.
        for ci in ("pending", "failure", "none", "quick"):
            self.assertEqual(decide_queue([qpr(5, ci=ci)]), ("enable", 5), ci)
        # Behind main is fine: the queue tests it with main.
        self.assertEqual(decide_queue([qpr(5, up_to_date=False)]), ("enable", 5))

    def test_refusals(self):
        for bad in (dict(draft=True), dict(labels=["hold"]), dict(dequeued=True),
                    dict(mergeable=False), dict(same_repo=False), dict(head_ref="feature/x"),
                    dict(base_ref="claude/other")):
            with self.subTest(**bad):
                self.assertIsNone(decide_queue([qpr(5, **bad)]))

    def test_drafted_held_or_removed_leave_the_queue(self):
        for bad in (dict(draft=True), dict(labels=["hold"]), dict(dequeued=True), dict(base_ref="claude/other")):
            with self.subTest(**bad):
                self.assertEqual(decide_queue([qpr(5, queued=True, **bad)]), ("disable", 5))
        # A conflict alone doesn't: GitHub won't queue it, and a push fixes it.
        self.assertIsNone(decide_queue([qpr(5, queued=True, mergeable=False)]))

    def test_lowest_number_first_and_skips(self):
        self.assertEqual(decide_queue([qpr(6), qpr(5)]), ("enable", 5))
        self.assertEqual(decide_queue([qpr(6), qpr(5)], skip={5}), ("enable", 6))

    def test_stack(self):
        child = qpr(6, base_ref="claude/t5")
        self.assertIsNone(decide_queue([qpr(5, queued=True), child]))
        child["base_in_main"] = True
        self.assertEqual(decide_queue([child]), ("retarget", 6))

    def test_old_way_never_merges_a_quick_head(self):
        quick = [check("kernel"), check("app"), check("e2e"), check("mutants-in-diff"), check("baseline"),
                 check("e2e (quick)")]
        self.assertEqual(ci_state(quick), "quick")
        # Planted: the same checks without the quick one are mergeable.
        self.assertEqual(ci_state(quick[:-1]), "success")
        # Another app's check of that name isn't ours.
        self.assertEqual(ci_state(quick[:-1] + [check("e2e (quick)", app="bot")]), "success")
        self.assertIsNone(decide([pr(5, ci="quick")]))
        self.assertIsNone(decide([pr(5, ci="quick", up_to_date=False)]))


class QueueFake(Fake):
    """Fake plus GraphQL: the queue state of each pull request, and every mutation."""

    def __init__(self, table, state):
        super().__init__(table)
        self.repo, self.state = "o/r", state

    def graphql(self, query, variables):
        if query.startswith("query"):
            n = variables["number"]
            return {"repository": {"pullRequest": dict(id=f"N{n}", **self.state[n])}}
        self.writes.append(("GRAPHQL", query.split("(")[1].split("{")[-1].strip(), variables))
        return {}


def queue_repo(labels=(), state=None, comments=(), pages_sha="m1"):
    gh = fake_repo()
    raw = gh.table["/pulls?state=open&per_page=100"][0]
    raw["labels"] = [dict(name=l) for l in labels]
    gh.table["/pulls/1"]["labels"] = raw["labels"]
    q = QueueFake(gh.table, {1: state or dict(isInMergeQueue=False, autoMergeRequest=None)})
    q.table.update({
        "/rules/branches/main": QUEUE_RULES,
        "/issues/1/comments?per_page=100": [dict(body=b) for b in comments],
        "/actions/workflows/pages.yml/runs?branch=main&per_page=5": dict(workflow_runs=[dict(head_sha=pages_sha)]),
    })
    return q


class QueueCalls(unittest.TestCase):
    def test_queue_rule_is_read(self):
        self.assertTrue(automerge.queue_required(queue_repo()))
        self.assertFalse(automerge.queue_required(fake_repo()))

        class Down(Fake):
            def call(self, method, path, body=None):
                raise urllib.error.HTTPError(path, 502, "Bad Gateway", {}, io.BytesIO(b""))
        # Can't read the rules: the old way, which only merges fully tested heads.
        self.assertFalse(automerge.queue_required(Down({})))

    def test_turns_on_merge_when_ready_and_never_merges_itself(self):
        gh = queue_repo()
        orig = gh.graphql

        def graphql(query, variables):
            r = orig(query, variables)
            if "enablePullRequestAutoMerge" in query:
                gh.state[1]["autoMergeRequest"] = dict(enabledAt="now")
            return r
        gh.graphql = graphql
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [("GRAPHQL", "enablePullRequestAutoMerge", {"id": "N1"})])
        # The next run finds it queued: nothing more.
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(len(gh.writes), 1)

    def test_hold_takes_it_out_of_the_queue(self):
        gh = queue_repo(labels=["hold"], state=dict(isInMergeQueue=True, autoMergeRequest=None))
        orig = gh.graphql

        def graphql(query, variables):
            r = orig(query, variables)
            if "dequeuePullRequest" in query:
                gh.state[1]["isInMergeQueue"] = False
            return r
        gh.graphql = graphql
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [("GRAPHQL", "dequeuePullRequest", {"id": "N1"})])
        # Not yet in the queue, only waiting for its checks: merge when ready goes off instead.
        gh = queue_repo(labels=["hold"], state=dict(isInMergeQueue=False, autoMergeRequest=dict(enabledAt="x")))
        automerge.run(gh, dry_run=False, log=lambda s: None)
        self.assertEqual(gh.writes[0], ("GRAPHQL", "disablePullRequestAutoMerge", {"id": "N1"}))

    def test_a_removed_head_is_not_queued_again_until_a_push(self):
        gh = queue_repo(comments=[automerge.dequeued_text("h1", "CI_FAILURE", "o/r")])
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [])
        # A new head (h2) goes back in.
        gh = queue_repo(comments=[automerge.dequeued_text("h0", "CI_FAILURE", "o/r")])
        gh.graphql = lambda q, v, f=gh.graphql: (gh.state[1].update(autoMergeRequest={}) if "enablePullRequestAutoMerge" in q else None) or f(q, v)
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [("GRAPHQL", "enablePullRequestAutoMerge", {"id": "N1"})])

    def test_dequeued_note_once_per_head(self):
        gh = queue_repo()
        orig = gh.call

        def call(method, path, body=None):
            r = orig(method, path, body)
            if method == "POST":
                gh.table["/issues/1/comments?per_page=100"].append(body)
            return r
        gh.call = call
        self.assertTrue(automerge.note_dequeued(gh, 1, "h1", "CI_FAILURE", log=lambda s: None))
        body = gh.writes[0][2]["body"]
        self.assertIn("<!-- automerge-dequeued:h1 -->", body)
        self.assertIn("`CI_FAILURE`", body)
        self.assertIn("event%3Amerge_group", body)
        self.assertFalse(automerge.note_dequeued(gh, 1, "h1", "CI_FAILURE", log=lambda s: None))
        self.assertEqual(len(gh.writes), 1)
        self.assertTrue(automerge.note_dequeued(gh, 1, "h2", "", log=lambda s: None))
        self.assertNotIn("reason", gh.writes[1][2]["body"])
        gh2 = queue_repo()
        automerge.note_dequeued(gh2, 1, "h1", "MANUAL", dry_run=True, log=lambda s: None)
        self.assertEqual(gh2.writes, [])

    def test_pages_deploys_main_once(self):
        # main is m1. A Pages run for m1 exists: nothing.
        gh = queue_repo(state=dict(isInMergeQueue=True, autoMergeRequest=None))
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [])
        # The last Pages run was for an older main: deploy.
        gh = queue_repo(state=dict(isInMergeQueue=True, autoMergeRequest=None), pages_sha="m0")
        automerge.run(gh, log=lambda s: None)
        self.assertEqual(gh.writes, [("POST", "/actions/workflows/pages.yml/dispatches", {"ref": "main"})])
        gh = queue_repo(state=dict(isInMergeQueue=True, autoMergeRequest=None), pages_sha="m0")
        automerge.run(gh, dry_run=True, log=lambda s: None)
        self.assertEqual(gh.writes, [])


class QueueSimulation(unittest.TestCase):
    """Seeded random pull requests and thread actions against decide_queue.
    After auto-merge has run to quiet, exactly the pull requests that should
    be queued (ready, no hold, on main, head not removed by the queue, not
    conflicted) are, and nothing else is; it never takes more than one action
    per pull request per run."""

    def test_runs(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                prs = {}
                for _ in range(1000):
                    n = rng.randrange(1, 8)
                    p = prs.setdefault(n, qpr(n))
                    change = rng.choice(("draft", "hold", "dequeue", "push", "conflict", "stack", "close"))
                    if change == "draft":
                        p["draft"] = not p["draft"]
                    elif change == "hold":
                        p["labels"] = [] if p["labels"] else ["hold"]
                    elif change == "dequeue":
                        p["queued"], p["dequeued"] = False, True
                    elif change == "push":
                        p["dequeued"], p["mergeable"] = False, rng.random() < 0.8
                    elif change == "conflict":
                        p["mergeable"] = False
                    elif change == "stack":
                        p["base_ref"] = "claude/t1" if p["base_ref"] == "main" else "main"
                        p["base_in_main"] = rng.random() < 0.5
                    else:
                        del prs[n]
                    acted = 0
                    while (action := decide_queue(list(prs.values()))) is not None:
                        acted += 1
                        self.assertLessEqual(acted, 2 * len(prs))
                        kind, m = action
                        q = prs[m]
                        if kind == "retarget":
                            q["base_ref"] = "main"
                        elif kind == "enable":
                            q["queued"] = True
                        else:
                            q["queued"] = False
                    for q in prs.values():
                        should = automerge.wanted_in_queue(q) and q["mergeable"] is not False
                        if should:
                            self.assertTrue(q["queued"], q)
                        elif not automerge.wanted_in_queue(q):
                            self.assertFalse(q["queued"], q)
