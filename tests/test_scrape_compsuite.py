from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))
import scrape_compsuite as compsuite  # noqa: E402


class RecentCompetitionTests(unittest.TestCase):
    def test_limits_live_pass_to_recent_completed_events(self):
        today = date(2026, 8, 6)
        comps = [
            {"competitionDate": "2026-08-06T19:00:00", "name": "Today"},
            {"competitionDate": "2026-08-05T19:00:00", "name": "Yesterday"},
            {"competitionDate": "2026-08-03T19:00:00", "name": "Older"},
            {"competitionDate": "2026-08-07T19:00:00", "name": "Future"},
            {"competitionDate": "unknown", "name": "Invalid"},
        ]

        selected = compsuite._recent_competitions(comps, 2, today=today)

        self.assertEqual([c["name"] for c in selected], ["Today", "Yesterday"])
        self.assertIs(compsuite._recent_competitions(comps, None, today=today), comps)


class LiveSyncTests(unittest.TestCase):
    def setUp(self):
        self.today = date.today()
        self.year = self.today.year
        self.name = "DCI Test Event"
        self.url = f"https://www.dci.org/scores/final-scores/{self.year}-dci-test-event/"
        self.old_classes = [{
            "class": "World Class",
            "results": [{"place": 1, "corps": "Bluecoats", "score": 90.0}],
        }]
        self.new_classes = [{
            "class": "World Class",
            "results": [
                {"place": 1, "corps": "Bluecoats", "score": 91.0},
                {"place": 2, "corps": "Blue Devils", "score": 90.5},
            ],
        }]
        self.official_recap = [{"class": "World Class", "rows": [{"corps": "Bluecoats"}]}]
        self.compsuite_recap = [{"class": "World Class", "rows": [{"corps": "Blue Devils"}]}]
        self.comp = {
            "competitionDate": self.today.isoformat() + "T19:00:00",
            "competitionGuid": "test-guid",
            "name": self.name,
            "location": "Test, USA",
        }

    def _event(self):
        return {
            "url": self.url,
            "slug": self.url.rstrip("/").rsplit("/", 1)[-1],
            "year": self.year,
            "name": self.name,
            "date": self.today.isoformat(),
            "classes": self.old_classes,
            "recap": self.official_recap,
        }

    def test_live_sync_updates_scores_but_preserves_official_recap(self):
        with tempfile.TemporaryDirectory() as td:
            parsed = Path(td)
            events_path = parsed / "dci_events.json"
            events_path.write_text(json.dumps([self._event()]))

            with (
                patch.object(compsuite, "PARSED", parsed),
                patch.object(compsuite, "_season_guid", return_value="season"),
                patch.object(compsuite, "_competitions", return_value=[self.comp]),
                patch.object(compsuite, "_canonical_urls",
                             return_value={compsuite._norm(self.name): self.url}),
                patch.object(compsuite, "_bridge", return_value={"rounds": []}),
                patch.object(compsuite, "_round_classes",
                             return_value=(self.new_classes, self.compsuite_recap)),
            ):
                compsuite.main(self.year, recent_days=2, sync_results=True)

            updated = json.loads(events_path.read_text())[0]
            self.assertEqual(updated["classes"], self.new_classes)
            self.assertEqual(updated["recap"], self.official_recap)

    def test_normal_pass_keeps_completed_official_event_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            parsed = Path(td)
            events_path = parsed / "dci_events.json"
            events_path.write_text(json.dumps([self._event()]))

            with (
                patch.object(compsuite, "PARSED", parsed),
                patch.object(compsuite, "_season_guid", return_value="season"),
                patch.object(compsuite, "_competitions", return_value=[self.comp]),
                patch.object(compsuite, "_canonical_urls",
                             return_value={compsuite._norm(self.name): self.url}),
                patch.object(compsuite, "_bridge") as bridge,
            ):
                compsuite.main(self.year)

            bridge.assert_not_called()
            unchanged = json.loads(events_path.read_text())[0]
            self.assertEqual(unchanged["classes"], self.old_classes)
            self.assertEqual(unchanged["recap"], self.official_recap)


if __name__ == "__main__":
    unittest.main()
