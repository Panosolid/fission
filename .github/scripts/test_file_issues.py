"""Tests for file_issues.py: python3 -m unittest discover -s .github/scripts"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from file_issues import MARK, fuzz_kinds, gather, harness_kinds, key, kinds_of, oracle_kinds, plan, read_folders, texts  # noqa: E402

# Lines copied from real reports on the test-results branch.
ROTATE_A = ("  seed 0x12849982fbf1: step 3 (Rotate { target: 1, pivot: [0.0, 0.0, 0.0], axis: [1.0, 0.0, 0.0], "
            "angle: -1.1000000000000001e-9 }): a vertex's distance to the pivot changed 0.7070990051357552 "
            "→ 0.7070990047468506 (minimal chain: 3 ops)")
ROTATE_B = ("  seed 0xf5514195a283: step 3 (Rotate { target: 1, pivot: [0.0, 0.0, -14.500011], axis: [1.0, 0.0, 0.0], "
            "angle: 3.9269908169872414 }): a vertex's distance to the pivot changed 14.577390679865436 "
            "→ 14.577390683031327 (minimal chain: 3 ops)")
ADD = ("  seed 0x74ed8ceb85a8: step 1 (Add { shape: Extrude { outer: Path { pts: [[0.0, 0.0], [0.5, 0.0]], "
       "bulges: [0.0, 1100000.0] }, holes: [], dist: 0.5, expect: Some(false) }, axis: [1.0, 0.0, 0.0], angle: 0.0, "
       "at: [0.0, 0.0, 0.0] }): sizes valid = false but kernel accepted (minimal chain: 1 ops)")
STL = ("  seed 0xea1bdc4749b2: step 1 (STL round trip of shape 0): STL mesh not closed after reading back: "
       "2 problems (minimal chain: 1 ops)")

DISAGREE = """line 276: {"Extrude": {"dist": "66.0", "expect": null, "holes": [], "outer": {"Path": {"bulges": [], "pts": [["0", "0"], ["1", "0"], ["1", "1"]]}}}}
  exact volume: fission 31.876169934868813, occ 31.87618745235322, allowed 1.56e-07
  bounds x: fission 1.0, occ 1.1
line 300: {"Extrude": {"dist": "1.0", "expect": null, "holes": [], "outer": {"Path": {"bulges": ["0.0", "1.0", "0.0"], "pts": [["0", "0"], ["1", "0"], ["1", "1"]]}}}}
  bounds y: fission 1.0, occ 1.1
occ-rounding, line 301: {"Box": {"w": "1.0", "d": "1.0", "h": "1.0"}}
  exact volume: fission 1.0, occ 1.1, exact 1.0, allowed 1e-09
"""


class Kinds(unittest.TestCase):
    def test_harness_kind_is_the_operation_and_the_message_without_numbers(self):
        # Worked by hand from the line: the op is "Rotate", the message after
        # "): " with each number replaced by # and the chain length dropped.
        want = "harness, Rotate: a vertex's distance to the pivot changed # → #"
        self.assertEqual([k for k, _ in harness_kinds(ROTATE_A)], [want])
        # A different angle and pivot is the same kind; the example is the line.
        self.assertEqual(harness_kinds(ROTATE_B)[0], (want, ROTATE_B.strip()))
        self.assertEqual(harness_kinds(ADD)[0][0], "harness, Add Extrude: sizes valid = false but kernel accepted")
        self.assertEqual(harness_kinds(STL)[0][0],
                         "harness, STL round trip of shape: STL mesh not closed after reading back: # problems")
        self.assertEqual(harness_kinds("Failures: 0\nPer operation ...\n"), [])

    def test_oracle_kinds(self):
        kinds = [k for k, _ in oracle_kinds(DISAGREE)]
        # bounds x and bounds y are one check; the second profile has an
        # arc; the occ-rounding block (only OpenCascade off) is no kind.
        self.assertEqual(kinds, ["OpenCascade disagrees, Extrude: exact volume",
                                 "OpenCascade disagrees, Extrude: bounds",
                                 "OpenCascade disagrees, Extrude with arcs: bounds"])
        self.assertEqual(oracle_kinds("oracle crashed\n")[0][0], "OpenCascade oracle crashed")
        # An unreadable shape is still reported.
        self.assertEqual(oracle_kinds("line 1: {nonsense\n  faces: fission 6, occ 5\n")[0][0],
                         "OpenCascade disagrees, ?: faces")

    def test_a_crash_without_a_report_is_a_kind(self):
        got = kinds_of({"harness-output.txt": "running 1 test\nthread panicked at src/x.rs:1\nerror: test failed\n"})
        self.assertEqual(list(got), ["harness crashed without a report"])
        self.assertIn("panicked", got["harness crashed without a report"])

    def test_one_kind_per_folder_once(self):
        got = kinds_of({"report.txt": ROTATE_A + "\n" + ROTATE_B + "\n", "oracle-disagreements.txt": DISAGREE})
        self.assertEqual(len(got), 4)


def issue(number, kind, state="OPEN", reason=None):
    return dict(number=number, state=state, stateReason=reason, body=f"{MARK.format(key(kind))}\ntext")


class Plan(unittest.TestCase):
    K = "harness, Rotate: a vertex's distance to the pivot changed # → #"
    FOUND = {K: [("1", "e")]}

    def test_each_state(self):
        self.assertEqual(plan(self.FOUND, [], "main"), [("create", self.K, None)])
        self.assertEqual(plan(self.FOUND, [issue(7, self.K)], "main"), [("comment", self.K, 7)])
        fixed = issue(7, self.K, "CLOSED", "COMPLETED")
        self.assertEqual(plan(self.FOUND, [fixed], "main"), [("reopen", self.K, 7)])
        # A branch may predate the fix: comment, don't reopen.
        self.assertEqual(plan(self.FOUND, [fixed], "claude/x"), [("comment", self.K, 7)])
        self.assertEqual(plan(self.FOUND, [issue(7, self.K, "CLOSED", "NOT_PLANNED")], "main"), [])

    def test_matches_by_marker_not_title(self):
        other = issue(3, "something else")
        self.assertEqual(plan(self.FOUND, [other], "main"), [("create", self.K, None)])
        # Two issues of one kind: the newer one is used.
        self.assertEqual(plan(self.FOUND, [issue(4, self.K, "CLOSED", "COMPLETED"), issue(9, self.K)], "main"),
                         [("comment", self.K, 9)])

    def test_texts(self):
        hits = [(str(s), "example line") for s in range(12)]
        title, body = texts("create", self.K, hits, "RUN", "abc1234", "main")
        self.assertEqual(title, "Random testing: " + self.K)
        self.assertIn(MARK.format(key(self.K)), body)
        self.assertIn("and 2 more", body)  # 12 seeds, 10 listed
        self.assertIn("FISSION_SEED=", body)
        self.assertIsNone(texts("comment", self.K, hits, "RUN", "abc1234", "main")[0])


# Reports as the fuzzers write them (kernel/tests/fuzz_stl.rs, packages/testing/src/project-fuzz.ts).
FUZZ_STL_A = """STL reader fuzzing, seed 11, 2000 inputs: 2 kind(s) of failure
failure: panic in stl::read: range end index 84 out of range for slice of length 83 at src/stl.rs:94 | case 315 | shrunk input: input-315.stl (83 bytes)
failure: accepted a malformed file | case 3 (model refuses it: WrongLength) | shrunk input: input-3.stl (85 bytes)
"""
FUZZ_STL_B = """STL reader fuzzing, seed 12, 2000 inputs: 1 kind(s) of failure
failure: panic in stl::read: range end index 84 out of range for slice of length 80 at src/stl.rs:95 | case 9 | shrunk input: input-9.stl (80 bytes)
"""
FUZZ_PROJECT = """Project loader fuzzing, seed 13, 2000 inputs: 1 kind(s) of failure
failure: saving lost or changed something the file had | case 34 | shrunk input: input-34.json (307 characters)
"""
FUZZ_SESSIONS = """Sketch-extrude sessions, seed 1000003, 40 steps: 1 kind(s) of failure
failure: volume 406830.71135582257, model 406830.7105421612 | seed 1000003, step 8 (extrude sketch-2 by 141): volume 406830.71135582257, model 406830.7105421612 | replay: FISSION_SEED=1000003 FISSION_SESSIONS=1 FISSION_SESSION_STEPS=40 npm run journeys
steps:
  0. draw 5 sides (2 arcs)
"""


class Fuzz(unittest.TestCase):
    def test_one_kind_per_failure_line_named_by_target(self):
        # Worked by hand: the target comes from the first line, the kind is
        # the text after "failure: " up to " | ", with numbers as #.
        self.assertEqual([k for k, _ in fuzz_kinds(FUZZ_STL_A)], [
            "fuzzing the STL reader: panic in stl::read: range end index # out of range for slice of length # at src/stl.rs:#",
            "fuzzing the STL reader: accepted a malformed file",
        ])
        # Another round's panic at other numbers is the same kind.
        self.assertEqual(fuzz_kinds(FUZZ_STL_B)[0][0], fuzz_kinds(FUZZ_STL_A)[0][0])
        self.assertEqual([k for k, _ in fuzz_kinds(FUZZ_PROJECT)], ["fuzzing the project loader: saving lost or changed something the file had"])
        # A session's kind is its problem with the numbers out; the steps after it are not kinds.
        self.assertEqual([k for k, _ in fuzz_kinds(FUZZ_SESSIONS)], ["fuzzing the sketch-extrude sessions: volume #, model #"])
        # A report with no failure lines has no kinds; an unknown first line still files, as "?".
        self.assertEqual(fuzz_kinds("STL reader fuzzing, seed 1, 2000 inputs: 0 kind(s) of failure\n"), [])
        self.assertEqual(fuzz_kinds("something else\nfailure: x | y")[0][0], "fuzzing the ?: x")

    def test_texts_say_how_to_replay_a_fuzzing_round(self):
        kind = fuzz_kinds(FUZZ_PROJECT)[0][0]
        title, body = texts("create", kind, [("13", "line")], "RUN", "abc1234", "main")
        self.assertEqual(title, "Fuzzing: project loader: saving lost or changed something the file had")
        self.assertIn(MARK.format(key(kind)), body)
        self.assertIn("npm run fuzz -w @fission/testing", body)
        self.assertIn("(fuzz/failures/seed-13/)", body)
        self.assertIn("fuzz/failures/seed-13/", texts("comment", kind, [("13", "line")], "RUN", "abc1234", "main")[1])

    def test_fuzz_folders_are_read_alongside_random_rounds(self):
        with tempfile.TemporaryDirectory() as d:
            for job, seed, name, text in (("fuzz-stl", "11", "fuzz-report.txt", FUZZ_STL_A), ("fuzz-stl", "12", "fuzz-report.txt", FUZZ_STL_B),
                                          ("fuzz-project", "13", "fuzz-report.txt", FUZZ_PROJECT), ("endless-a-0", "22", "report.txt", ROTATE_A)):
                os.makedirs(os.path.join(d, job, f"seed-{seed}"))
                with open(os.path.join(d, job, f"seed-{seed}", name), "w") as f:
                    f.write(text)
            found = gather(read_folders(d))
        self.assertEqual(sorted((k.split(":")[0], [s for s, _ in v]) for k, v in found.items()), [
            ("fuzzing the STL reader", ["11"]),
            ("fuzzing the STL reader", ["11", "12"]),
            ("fuzzing the project loader", ["13"]),
            ("harness, Rotate", ["22"]),
        ])


class Folders(unittest.TestCase):
    def test_reads_every_seed_folder_and_groups_kinds(self):
        with tempfile.TemporaryDirectory() as d:
            for job, seed, text in (("endless-a-0", "11", ROTATE_A), ("endless-b-3", "22", ROTATE_B),
                                    ("mutants-0", "33", ROTATE_A)):
                os.makedirs(os.path.join(d, job, f"seed-{seed}"))
                with open(os.path.join(d, job, f"seed-{seed}", "report.txt"), "w") as f:
                    f.write(text)
            found = gather(read_folders(d))
        # Two rounds, one kind; the mutants folder is not a random round.
        self.assertEqual(list(found.values()), [[("11", ROTATE_A.strip()), ("22", ROTATE_B.strip())]])


if __name__ == "__main__":
    unittest.main()
