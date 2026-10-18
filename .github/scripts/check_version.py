"""VERSION against CHANGELOG.md.

VERSION (repository root) holds one version, big.step.bugfix (CHANGELOG.md's
opening paragraph says what each number means). The check fails when:
- VERSION isn't exactly three whole numbers with dots and no leading zeros,
  on one line;
- a "## " heading in CHANGELOG.md isn't a version heading "## X.Y.Z (date)";
- the newest (first) version heading isn't the one in VERSION;
- the headings aren't newest first, one version after another: within a step
  the bug-fix number goes up by exactly one, and a new step starts at .0.

`check` is pure (tested in test_check_version.py, which also runs it on the
repository's own two files, so CI's kernel job checks them on every PR).

Usage: check_version.py [ROOT]   (default: the repository root)
"""

import os
import re
import sys

VERSION_RE = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
HEADING_RE = re.compile(r"## (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) \(\d{4}-\d{2}-\d{2}\)$")


def parse_version(text):
    """The (big, step, bugfix) in VERSION's text, or None if it isn't valid."""
    if text.endswith("\n"):
        text = text[:-1]
    m = VERSION_RE.fullmatch(text)
    return tuple(int(g) for g in m.groups()) if m else None


def headings(changelog):
    """(line number, version or None) for every "## " heading."""
    found = []
    for n, line in enumerate(changelog.splitlines(), 1):
        if line.startswith("## "):
            m = HEADING_RE.fullmatch(line.rstrip())
            found.append((n, tuple(int(g) for g in m.groups()) if m else None))
    return found


def show(v):
    return ".".join(map(str, v))


def follows(newer, older):
    """Whether `newer` is the version straight after `older`."""
    if newer[:2] == older[:2]:
        return newer[2] == older[2] + 1
    return newer[:2] > older[:2] and newer[2] == 0


def check(version_text, changelog):
    """Every problem found, as one sentence each; empty when all is well."""
    errors = []
    version = parse_version(version_text)
    if version is None:
        errors.append(f"VERSION should be big.step.bugfix like 0.24.0 on one line, not {version_text!r}")
    found = headings(changelog)
    for n, v in found:
        if v is None:
            errors.append(f"CHANGELOG.md line {n}: a ## heading must be a version, like '## 0.24.0 (2026-10-18)'")
    versions = [(n, v) for n, v in found if v is not None]
    if not versions:
        errors.append("CHANGELOG.md has no version heading")
        return errors
    if version is not None and versions[0][1] != version:
        errors.append(
            f"VERSION says {show(version)} but CHANGELOG.md's newest heading (line {versions[0][0]}) is {show(versions[0][1])}"
        )
    for (n_new, newer), (n_old, older) in zip(versions, versions[1:]):
        if not follows(newer, older):
            errors.append(
                f"CHANGELOG.md line {n_new}: {show(newer)} doesn't come straight after {show(older)} (line {n_old}); "
                "newest first, bug fixes count up by one, a new step starts at .0"
            )
    return errors


def main(argv):
    root = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..")
    with open(os.path.join(root, "VERSION"), encoding="utf-8") as f:
        version_text = f.read()
    with open(os.path.join(root, "CHANGELOG.md"), encoding="utf-8") as f:
        changelog = f.read()
    errors = check(version_text, changelog)
    for e in errors:
        print(e)
    if not errors:
        print(f"VERSION {version_text.strip()} matches CHANGELOG.md")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
