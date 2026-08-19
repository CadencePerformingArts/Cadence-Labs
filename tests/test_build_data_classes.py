"""Class assignment in build_data.

The pre-2013 archive records a show's division per RESULT ROW, so a show that
is entirely one division leaves that column blank and every row falls back to
the top class. That is how 2008's Open Class champions ended up ranked against
Division I on the World Class board. These tests pin the two corrections that
undo it — the show's own name, and the class of the field it kept — and, just
as importantly, pin the case that must NOT be corrected: Open Class corps
genuinely touring into a World Class show.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scraper"))
import build_data  # noqa: E402

PARSED = ROOT / "data" / "parsed"


def results(*corps):
    return [{"place": i + 1, "corps": c, "score": 90.0 - i} for i, c in enumerate(corps)]


def load(events):
    """Run load_events() over a hand-built event list."""
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "dci_events.json").write_text(json.dumps(events))
        with patch.object(build_data, "PARSED", Path(tmp)):
            return build_data.load_events()


def classes_of(events, name):
    ev = next(e for e in events if e["name"] == name)
    return {c["class"]: [r["corps"] for r in c["results"]] for c in ev["classes"]}


class EventNameTests(unittest.TestCase):
    def test_numbered_divisions_are_the_lower_class(self):
        for name, year in [
            ("DCI World Championships Division II Prelims", 1998),
            ("DCI World Championships Division III Finals", 1996),
            ("DCI Championships - Div II Prelims", 2001),
            ("Menasha WI DCI Division II & III Show", 2002),
            ("American International Open Div II Finals", 1984),
        ]:
            self.assertTrue(build_data.event_is_lower_class(name, year), name)

    def test_open_class_only_reads_as_lower_from_2008(self):
        # DCI renamed Division II/III to Open Class in 2008
        self.assertTrue(build_data.event_is_lower_class("Open Class Finals", 2008))
        self.assertTrue(build_data.event_is_lower_class(
            "DCI World Championships Open Class Championship Prelims", 2011))
        # before that "Open Class" named the TOP division — DCI's own through
        # 1983, and the UK and Dutch circuits' for longer still
        self.assertFalse(build_data.event_is_lower_class("Open Class Finals", 1995))
        self.assertFalse(build_data.event_is_lower_class("DCUK Open Class Finals", 1998))
        self.assertFalse(build_data.event_is_lower_class(
            "DCI World Championships Open Class Prelims", 1983))

    def test_a_name_that_states_the_top_division_is_left_alone(self):
        for name, year in [
            ("DCI World Championship Prelims", 2026),
            ("World Class Finals", 2008),
            ("DCI World Championships Division I Prelims", 1998),
            ("World Class & Open Class Championship", 2010),
            ("", 2008),
        ]:
            self.assertFalse(build_data.event_is_lower_class(name, year), name)


class FieldMembershipTests(unittest.TestCase):
    """A corps competes in one class per season, so the field a show keeps
    says which class it was — even when nothing in its name does."""

    def test_all_open_class_field_leaves_world_class(self):
        events = load([
            # the source labels this one, seeding the season's open roster
            {"year": 2008, "name": "Open Class Prelims", "date": "2008-06-22",
             "classes": [{"class": "Open Class",
                          "results": results("Blue Devils B", "Jersey Surf")}]},
            # …this one it doesn't, and its whole field is that same roster
            # plus a corps the source never labels anywhere
            {"year": 2008, "name": "Dayton Summer Classic", "date": "2008-08-03",
             "classes": [{"class": "World Class",
                          "results": results("Blue Devils B", "Jersey Surf", "Strangnas")}]},
            # an unambiguous World Class field, so the season has a world roster
            {"year": 2008, "name": "DCI Eastern Classic", "date": "2008-08-02",
             "classes": [{"class": "World Class",
                          "results": results("Phantom Regiment", "The Cadets")}]},
        ])
        self.assertEqual(classes_of(events, "Dayton Summer Classic"),
                         {"Open Class": ["Blue Devils B", "Jersey Surf", "Strangnas"]})
        self.assertEqual(classes_of(events, "DCI Eastern Classic"),
                         {"World Class": ["Phantom Regiment", "The Cadets"]})

    def test_open_class_corps_touring_a_world_class_show_stay_put(self):
        """The genuine case: Colt Cadets at World Championship Prelims are a
        World Class result, and the World Class corps beside them prove it."""
        events = load([
            {"year": 2026, "name": "Open Class Prelims", "date": "2026-08-04",
             "classes": [{"class": "Open Class",
                          "results": results("Colt Cadets", "Les Stentors")}]},
            {"year": 2026, "name": "DCI Southwestern Championship", "date": "2026-07-18",
             "classes": [{"class": "World Class",
                          "results": results("Blue Devils", "Bluecoats")}]},
            {"year": 2026, "name": "DCI World Championship Prelims", "date": "2026-08-06",
             "classes": [{"class": "World Class",
                          "results": results("Blue Devils", "Bluecoats", "Colt Cadets")}]},
        ])
        self.assertEqual(classes_of(events, "DCI World Championship Prelims"),
                         {"World Class": ["Blue Devils", "Bluecoats", "Colt Cadets"]})

    def test_a_season_with_no_open_roster_is_untouched(self):
        events = load([
            {"year": 1975, "name": "VFW National Championship", "date": "1975-08-16",
             "classes": [{"class": "World Class",
                          "results": results("Santa Clara Vanguard", "Madison Scouts")}]},
        ])
        self.assertEqual(classes_of(events, "VFW National Championship"),
                         {"World Class": ["Santa Clara Vanguard", "Madison Scouts"]})

    def test_an_explicit_world_class_group_survives_an_open_class_name(self):
        # the real 2013 So Cal Classic: the source separated a genuine World
        # Class group (Pacific Crest, Mandarins) from the Open Class group. The
        # event name says "Open Class" but the populated division column is the
        # authority — the World Class group must NOT be swept into Open Class.
        events = load([
            {"year": 2013, "name": "So Cal Classic Open Class Championships",
             "date": "2013-07-14", "classes": [
                 {"class": "Open Class", "results": results("Vanguard Cadets", "Impulse")},
                 {"class": "World Class", "results": results("Pacific Crest", "Mandarins")},
             ]},
            # a plain World Class show for the two of them, so the season has a
            # world roster that also protects them from the field-membership rule
            {"year": 2013, "name": "DCI Southwestern", "date": "2013-07-20",
             "classes": [{"class": "World Class",
                          "results": results("Pacific Crest", "Mandarins", "Blue Devils")}]},
        ])
        cls = classes_of(events, "So Cal Classic Open Class Championships")
        self.assertEqual(sorted(cls["World Class"]), ["Mandarins", "Pacific Crest"])
        self.assertEqual(sorted(cls["Open Class"]), ["Impulse", "Vanguard Cadets"])
        # …and their other World Class result is untouched
        self.assertEqual(
            set(classes_of(events, "DCI Southwestern")["World Class"]),
            {"Pacific Crest", "Mandarins", "Blue Devils"})

    def test_an_unlabelled_field_with_no_evidence_keeps_its_class(self):
        """No open-roster corps in the field and no name to go on: the rule
        stays quiet rather than guessing."""
        events = load([
            {"year": 2013, "name": "Open Class Prelims", "date": "2013-07-01",
             "classes": [{"class": "Open Class", "results": results("Vanguard Cadets")}]},
            {"year": 2013, "name": "Sacramento Show", "date": "2013-07-06",
             "classes": [{"class": "World Class", "results": results("Gold", "Watchmen")}]},
        ])
        self.assertEqual(classes_of(events, "Sacramento Show"),
                         {"World Class": ["Gold", "Watchmen"]})


class NonFieldEntryTests(unittest.TestCase):
    def test_mini_corps_entries_never_reach_a_board(self):
        events = load([
            {"year": 2008, "name": "Bugler's Hall of Fame Championship", "date": "2008-03-29",
             "classes": [{"class": "World Class",
                          "results": results("Capital Brass MiniCorps", "Mass Brass Mini Corps",
                                             "Blue Devils")}]},
        ])
        self.assertEqual(classes_of(events, "Bugler's Hall of Fame Championship"),
                         {"World Class": ["Blue Devils"]})


@unittest.skipUnless((PARSED / "history_events.json").exists(),
                     "needs the committed scrape inputs")
class CommittedInputTests(unittest.TestCase):
    """End-to-end over the real inputs: the seasons the user can actually
    open must not rank Open Class corps against World Class ones."""

    @classmethod
    def setUpClass(cls):
        cls.events = build_data.load_events()

    def world_class_corps(self, year):
        return {r["corps"] for ev in self.events if ev["year"] == year
                for c in ev["classes"] if c["class"] == "World Class"
                for r in c["results"]}

    def test_2008_open_class_champions_are_not_world_class(self):
        wc = self.world_class_corps(2008)
        for corps in ("Blue Devils B", "Vanguard Cadets", "Jersey Surf",
                      "Oregon Crusaders", "Teal Sound"):
            self.assertNotIn(corps, wc, f"{corps} is an Open Class corps in 2008")
        # …and the real World Class field is still all there
        for corps in ("Phantom Regiment", "Blue Devils", "The Cavaliers",
                      "Carolina Crown", "The Cadets", "Bluecoats",
                      "Santa Clara Vanguard"):
            self.assertIn(corps, wc, corps)

    def test_open_class_corps_still_count_at_world_class_shows(self):
        """2026's Open Class corps really did compete at World Championship
        Prelims — that result belongs on the World Class board."""
        prelims = [ev for ev in self.events
                   if ev["year"] == 2026 and ev["name"] == "DCI World Championship Prelims"]
        self.assertTrue(prelims, "2026 World Championship Prelims missing")
        field = {r["corps"] for c in prelims[0]["classes"]
                 if c["class"] == "World Class" for r in c["results"]}
        self.assertIn("Colt Cadets", field)
        self.assertIn("Blue Devils", field)


if __name__ == "__main__":
    unittest.main()
