#!/usr/bin/env python3
"""Concatenate supabase/migrations/*.sql into the two paste-and-run bundles.

RUN_ALL.sql      — everything, for a project with no migrations applied
RUN_ENSEMBLE.sql — 0005 onward, for a project that already has 0001-0004

Each bundle is one transaction: if anything fails nothing is applied, so a
half-migrated database is impossible. Regenerate after adding a migration:

    python3 scripts/gen_sql_bundles.py
"""
from pathlib import Path
import re

MIG = Path(__file__).resolve().parent.parent / "supabase" / "migrations"

HEADER = """-- ═══════════════════════════════════════════════════════════════════
-- CADENCE — {title}
--
-- {purpose}
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. It runs as one transaction: if anything fails nothing
-- is applied, so you can fix and re-run without half-migrated tables.
--
-- Generated from supabase/migrations/*.sql — do not edit by hand.
-- ═══════════════════════════════════════════════════════════════════

begin;
"""


def bundle(out_name, title, purpose, keep):
    files = sorted(p for p in MIG.glob("[0-9]*.sql") if keep(p.name))
    parts = [HEADER.format(title=title, purpose=purpose)]
    for p in files:
        parts.append(
            "\n\n-- ───────────────────────────────────────────────\n"
            f"-- {p.name}\n"
            "-- ───────────────────────────────────────────────\n"
            + p.read_text().rstrip()
            + "\n"
        )
    parts.append("\n\ncommit;\n")
    (MIG / out_name).write_text("".join(parts))
    print(f"{out_name}: {len(files)} migrations, {sum(len(x) for x in parts)} chars")
    return [p.name for p in files]


def main():
    all_names = bundle(
        "RUN_ALL.sql",
        "complete database setup",
        "Every table Cadence needs, on a project where no migration has run yet.",
        lambda n: True,
    )
    ens_names = bundle(
        "RUN_ENSEMBLE.sql",
        "Cadence Ensemble only",
        "Use when 0001-0004 are already applied and only the workspace system is missing.",
        lambda n: re.match(r"^\d{4}", n) and int(n[:4]) >= 5,
    )
    assert all_names[: len(all_names) - len(ens_names)] + ens_names == all_names


if __name__ == "__main__":
    main()
