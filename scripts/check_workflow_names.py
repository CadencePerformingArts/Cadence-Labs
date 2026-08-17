#!/usr/bin/env python3
"""Fail loudly if ci-status.yml watches a workflow name that no longer exists.

GitHub's `workflow_run` trigger matches on a workflow's `name:`, not its
filename, so renaming a workflow silently breaks any status monitor watching
the old name. This guard cross-checks every name listed under
ci-status.yml's `workflow_run.workflows` against the actual `name:` of the
workflow files, and exits non-zero on a mismatch.

    python3 scripts/check_workflow_names.py

Run it in App CI so a rename can't ship without updating the watch list.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

WF = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def workflow_names() -> set[str]:
    names = set()
    for f in WF.glob("*.yml"):
        m = re.search(r"^name:\s*(.+?)\s*$", f.read_text(), re.M)
        if m:
            names.add(m.group(1).strip().strip('"').strip("'"))
    return names


def watched_names() -> list[str]:
    text = (WF / "ci-status.yml").read_text()
    m = re.search(r"workflows:\s*\[(.*?)\]", text, re.S)
    if not m:
        return []
    return [s.strip().strip('"').strip("'") for s in m.group(1).split(",") if s.strip()]


def main() -> int:
    have = workflow_names()
    watched = watched_names()
    missing = [w for w in watched if w not in have]
    if missing:
        print("ci-status.yml watches workflow name(s) that do not exist:", file=sys.stderr)
        for w in missing:
            print(f"  - {w!r}", file=sys.stderr)
        print("Known workflow names:", ", ".join(sorted(have)), file=sys.stderr)
        return 1
    print(f"ci-status watches {len(watched)} workflow(s), all present: {', '.join(watched)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
