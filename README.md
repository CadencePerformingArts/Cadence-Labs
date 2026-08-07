# Corps Central — DCI & DCA scores dashboard

An automatically-updating public dashboard for Drum Corps International (DCI) and
Drum Corps Associates (DCA): live season standings, complete score history back
to 1972, caption recaps, corps histories, champions timelines, and news.

**Live site:** https://lukebesel.github.io/DCI-Tracker/

## How it works

- `scraper/` — Python scrapers for DCI.org (2013+, with caption recaps),
  drum-corps.net archives (2001+, DCI & DCA), The Sound Machine historical
  finals archive (1972–2004, incl. repertoires and archival recaps),
  dcacorps.org, Wikipedia (DCA champions), and news feeds.
- `data/raw/` — gzipped page cache (so reruns don't refetch history).
- `data/parsed/` — intermediate normalized JSON per source.
- `docs/` — the static site (GitHub Pages serves this folder) and its
  `docs/data/` JSON built by `scraper/build_data.py`.
- `.github/workflows/update.yml` — runs twice daily: refreshes the current
  season, news, and DCA pages, rebuilds the site data, commits.
- `.github/workflows/backfill.yml` — manual full historical scrape.

## Running locally

```bash
pip install -r scraper/requirements.txt
export PYTHONPATH=scraper
python scraper/scrape_dci.py           # 2013+ events + recaps (long)
python scraper/scrape_dcnet.py         # 2001+ archives
python scraper/scrape_history.py       # 1972-2004 finals + DCA champions
python scraper/scrape_dca_site.py
python scraper/scrape_news.py
python scraper/build_data.py           # -> docs/data/
python -m http.server -d docs 8000
```

## Data sources & credit

Scores originate from [DCI.org](https://www.dci.org/scores) (powered by
Competition Suite), [drum-corps.net](https://www.drum-corps.net),
[The Sound Machine](https://www.soundmachine.org/dci/dcihistory.htm),
[dcacorps.org](https://dcacorps.org) and
[Wikipedia](https://en.wikipedia.org/wiki/Drum_Corps_Associates).
This is an unofficial fan project, not affiliated with DCI or DCA. Scrapers are
rate-limited and cache aggressively to keep load on source sites minimal.
