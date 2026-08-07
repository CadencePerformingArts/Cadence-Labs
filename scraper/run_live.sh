#!/usr/bin/env bash
# Focused show-night path: refresh only recently completed CompetitionSuite
# events, then rebuild the static JSON. The comprehensive update workflow keeps
# running every ~12-15 minutes as the fallback for mirrors, news, and history.
set -u

YEAR="${1:-$(date -u +%Y)}"
export PYTHONPATH=scraper
REPORT=data/live_scrape_report.txt
mkdir -p data
: > "$REPORT"
echo "mode=live started=$(date -u +'%F %T UTC')" >> "$REPORT"

run() {
  local name="$1"; shift
  local t0=$SECONDS
  echo "::group::$name"
  if timeout --preserve-status --kill-after=10 "${STEP_TIMEOUT:-120}" "$@"; then
    echo "$name: OK ($((SECONDS-t0))s)" >> "$REPORT"
  else
    echo "$name: FAILED exit=$? ($((SECONDS-t0))s)" >> "$REPORT"
  fi
  echo "::endgroup::"
}

# Two days covers the UTC/local-date boundary and late-posted score corrections
# while reducing a live pass from the full season to only the active shows.
FETCH_RETRIES=1 STEP_TIMEOUT=150 run "CompetitionSuite recent events" \
  python scraper/scrape_compsuite.py "$YEAR" --recent-days 2 --sync-results

run "build site data" python scraper/build_data.py

echo "finished=$(date -u +'%F %T UTC')" >> "$REPORT"
cat "$REPORT"
test -f docs/data/meta.json
