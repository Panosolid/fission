"""Tests for check_version.py: python3 -m unittest discover -s .github/scripts"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from check_version import check, follows, parse_version  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")

GOOD = """# Changelog

Intro words; a line starting "##" only counts at the start of a line.

## 0.24.1 (2026-10-18)

- A fix.

## 0.24.0 (2026-10-17)

- Step 24 begins.

## 0.23.0 (2026-10-17)

- Step 23.
"""


class ParseVersion(unittest.TestCase):
    def test_hand_worked(self):
        # "0.24.10" is big 0, step 24, bug fix 10: three numbers, dots between.
        self.assertEqual(parse_version("0.24.10\n"), (0, 24, 10))
        self.assertEqual(parse_version("0.24.0"), (0, 24, 0))
        self.assertEqual(parse_version("1.0.0\n"), (1, 0, 0))

    def test_refused(self):
        for bad in ["", "\n", "0.24", "0.24.0.1", "v0.24.0", "0.24.x", "0.024.0", "00.24.0", "0.24.01",
                    " 0.24.0", "0.24.0 ", "0.24.0\n\n", "0.24.-1", "0,24,0"]:
            self.assertIsNone(parse_version(bad), bad)


class Follows(unittest.TestCase):
    def test_hand_worked(self):
        # Within step 24 a bug fix adds one: 0.24.9 -> 0.24.10 (numbers, not text: "10" > "9").
        self.assertTrue(follows((0, 24, 10), (0, 24, 9)))
        # A new step starts at .0, from whatever bug fix the last one reached.
        self.assertTrue(follows((0, 24, 0), (0, 23, 0)))
        self.assertTrue(follows((0, 19, 0), (0, 18, 1)))
        # A jump of steps is allowed (a step with no entry of its own): 0.14.0 -> 0.16.0.
        self.assertTrue(follows((0, 16, 0), (0, 14, 0)))
        self.assertTrue(follows((1, 0, 0), (0, 40, 3)))

    def test_refused(self):
        self.assertFalse(follows((0, 24, 2), (0, 24, 0)))  # a skipped fix
        self.assertFalse(follows((0, 24, 1), (0, 24, 1)))  # the same version twice
        self.assertFalse(follows((0, 24, 0), (0, 24, 1)))  # oldest first
        self.assertFalse(follows((0, 24, 1), (0, 23, 0)))  # a new step not at .0
        self.assertFalse(follows((0, 23, 0), (0, 24, 0)))  # steps going backwards


class Check(unittest.TestCase):
    def test_good(self):
        self.assertEqual(check("0.24.1\n", GOOD), [])

    def test_version_not_the_newest_heading(self):
        self.assertEqual(
            check("0.24.0\n", GOOD),
            ["VERSION says 0.24.0 but CHANGELOG.md's newest heading (line 5) is 0.24.1"],
        )

    def test_bad_version_file(self):
        errors = check("0.24\n", GOOD)
        self.assertEqual(len(errors), 1)
        self.assertIn("VERSION should be big.step.bugfix", errors[0])

    def test_heading_that_isnt_a_version(self):
        broken = GOOD.replace("## 0.24.0 (2026-10-17)", "## 0.24.x (2026-10-17)")
        errors = check("0.24.1\n", broken)
        self.assertIn("CHANGELOG.md line 9: a ## heading must be a version, like '## 0.24.0 (2026-10-18)'", errors)

    def test_heading_without_its_date(self):
        broken = GOOD.replace("## 0.24.1 (2026-10-18)", "## 0.24.1")
        self.assertIn("CHANGELOG.md line 5: a ## heading must be a version, like '## 0.24.0 (2026-10-18)'",
                      check("0.24.1\n", broken))

    def test_skipped_fix(self):
        broken = GOOD.replace("## 0.24.1 ", "## 0.24.2 ")
        self.assertEqual(
            check("0.24.2\n", broken),
            ["CHANGELOG.md line 5: 0.24.2 doesn't come straight after 0.24.0 (line 9); "
             "newest first, bug fixes count up by one, a new step starts at .0"],
        )

    def test_oldest_first(self):
        swapped = GOOD.replace("## 0.24.1 (2026-10-18)", "## TMP").replace(
            "## 0.23.0 (2026-10-17)", "## 0.24.1 (2026-10-18)").replace("## TMP", "## 0.23.0 (2026-10-17)")
        errors = check("0.23.0\n", swapped)
        self.assertEqual(len(errors), 2)  # 0.24.0 after 0.23.0, then 0.24.1 under 0.24.0
        self.assertTrue(all("doesn't come straight after" in e for e in errors))

    def test_no_versions(self):
        self.assertEqual(check("0.1.0\n", "# Changelog\n"), ["CHANGELOG.md has no version heading"])


class RepositoryFiles(unittest.TestCase):
    """The real VERSION and CHANGELOG.md, checked on every PR by CI's kernel job."""

    def test_version_matches_changelog(self):
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
            version_text = f.read()
        with open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8") as f:
            changelog = f.read()
        self.assertEqual(check(version_text, changelog), [])


if __name__ == "__main__":
    unittest.main()
