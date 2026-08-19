#!/usr/bin/env python3
"""Fail loudly if a `workflow_run` trigger watches a workflow that no longer exists.

GitHub's `workflow_run` trigger matches on a workflow's `name:`, not its
filename, so renaming or deleting a workflow silently breaks any monitor
watching the old name. This guard cross-checks every watched name against the
actual `name:` of the workflow files, and exits non-zero on a mismatch.

    python3 scripts/check_workflow_names.py

Run it in App CI so a rename can't ship without updating the watch list.

WHY IT LOOKS LIKE THIS
----------------------
The first version could pass without checking anything, which is worse than
no guard at all. Two holes, both now closed:

1. It read the watch list with a single regex, ``workflows:\\s*\\[(.*?)\\]``,
   which only understands the inline-flow form ``workflows: [a, b]``. Rewrite
   ci-status.yml to the equally valid block form::

       workflows:
         - "Data update"

   and the regex matched nothing, ``watched`` came back empty, ``missing`` was
   therefore empty too, and the guard printed "watches 0 workflow(s), all
   present" and exited 0. A pure reformat disabled the check. Both forms are
   parsed now, and a `workflows:` key that yields nothing is an error rather
   than an empty pass.

2. It only ever looked at ci-status.yml. Any other workflow_run watcher added
   later would go unchecked. It now scans every workflow file, so a new
   monitor is covered the day it lands.

Deliberately stdlib-only, no PyYAML: this runs on a bare runner, and a guard
that fails because its own dependency is missing is not a guard. The parsing
is line-based and narrow on purpose — it understands the two list forms
GitHub accepts for this key and nothing more.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

WF = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def _strip(item: str) -> str:
    """One list entry -> the bare workflow name."""
    item = item.strip()
    if item and item[0] in "\"'" and item[-1] == item[0] and len(item) > 1:
        return item[1:-1]
    # only an unquoted entry can carry a trailing `# comment`
    return item.split("#", 1)[0].strip()


def _split_flow(body: str) -> list[str]:
    """`"a", "b"` -> ['a', 'b'], respecting quotes so a comma inside a name survives."""
    out, cur, quote = [], "", ""
    for ch in body:
        if quote:
            cur += ch
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            cur += ch
        elif ch == ",":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [s for s in (_strip(x) for x in out) if s]


def workflow_names() -> dict[str, str]:
    """Top-level `name:` of every workflow file -> filename."""
    names: dict[str, str] = {}
    for f in sorted(WF.glob("*.y*ml")):
        # column-0 `name:` only; a step's `name:` is always indented
        m = re.search(r"^name:\s*(.+?)\s*$", f.read_text(), re.M)
        if m:
            names[_strip(m.group(1))] = f.name
    return names


def watchers() -> list[tuple[str, list[str]]]:
    """Every `workflow_run.workflows` list in the repo, as (filename, names).

    Returns one entry per workflow_run block found, so a file with a broken or
    empty list still shows up (as an empty list) and can be reported, instead
    of vanishing into a silent pass.
    """
    found: list[tuple[str, list[str]]] = []
    for f in sorted(WF.glob("*.y*ml")):
        lines = f.read_text().splitlines()
        in_run_at = None  # indent of the `workflow_run:` key
        for i, line in enumerate(lines):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            if re.match(r"^\s*workflow_run:\s*(#.*)?$", line):
                in_run_at = indent
                continue
            if in_run_at is None:
                continue
            if indent <= in_run_at:  # dedented back out of the block
                in_run_at = None
                continue
            m = re.match(r"^\s*workflows:\s*(.*)$", line)
            if not m:
                continue
            rest = m.group(1).strip()
            if rest.startswith("["):
                # inline flow list, possibly wrapping across lines
                buf = rest
                j = i
                while "]" not in buf and j + 1 < len(lines):
                    j += 1
                    buf += " " + lines[j].strip()
                found.append((f.name, _split_flow(buf[buf.index("[") + 1: buf.rindex("]")] if "]" in buf else buf[1:])))
            else:
                # block list on the following lines
                items, j = [], i + 1
                while j < len(lines):
                    nxt = lines[j]
                    if not nxt.strip() or nxt.lstrip().startswith("#"):
                        j += 1
                        continue
                    if len(nxt) - len(nxt.lstrip()) <= indent or not nxt.lstrip().startswith("- "):
                        break
                    items.append(_strip(nxt.lstrip()[2:]))
                    j += 1
                found.append((f.name, [x for x in items if x]))
    return found


def main() -> int:
    have = workflow_names()
    found = watchers()
    problems: list[str] = []

    if not found:
        problems.append(
            "no workflow_run watcher found in .github/workflows — ci-status.yml is "
            "the repo's status monitor; if it was deleted on purpose, delete this "
            "guard and its App CI step too"
        )

    for fname, watched in found:
        if not watched:
            problems.append(
                f"{fname}: a workflow_run block declares `workflows:` but no names "
                f"parsed out of it. An empty watch list monitors nothing — fix the "
                f"list, or remove the trigger"
            )
            continue
        for w in watched:
            if w not in have:
                problems.append(f"{fname}: watches {w!r}, which is not the name: of any workflow file")

    if problems:
        print("workflow watch lists are out of sync:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\nKnown workflow names:\n  "
            + "\n  ".join(f"{n!r}  ({f})" for n, f in sorted(have.items())),
            file=sys.stderr,
        )
        return 1

    for fname, watched in found:
        print(f"{fname} watches {len(watched)} workflow(s), all present: {', '.join(watched)}")
    # Informational, never fatal: ci-status watches the data/deploy workflows
    # on purpose and must NOT watch App CI or QA (a status monitor that watches
    # the CI that runs it is a loop). Printed so an added workflow is visible
    # in the log the day it lands, and someone can decide.
    unwatched = sorted(set(have) - {w for _, ws in found for w in ws})
    if unwatched:
        print("not watched by any monitor (informational): " + ", ".join(repr(u) for u in unwatched))
    return 0


if __name__ == "__main__":
    sys.exit(main())
