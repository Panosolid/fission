#!/usr/bin/env bash
# Adds one "Random testing" run to the test-results branch: every round's line
# to log.csv, failure folders to failures/<seed>/, the nightly mutation run to
# mutants/, then rewrites summary.txt, files one issue per kind of problem
# (file_issues.py, which must sit next to this script) and opens one for new
# mutation survivors. Called by the collect job in .github/workflows/nightly.yml,
# from a checkout of the repository with full history.
#
# Runs on different branches can finish at the same moment, so the push may be
# refused: then it starts again from the branch as it now is and re-applies
# this run (the inputs are all in $IN, so applying twice gives the same result).
#
# Environment:
#   IN              downloaded artifacts: endless-*/ (endless.sh results),
#                   mutants-*/ (one cargo mutants shard each: its *.txt lists
#                   and exit-code.txt), golden/ (the golden models' night:
#                   report.txt, measured.json, baseline.txt and, if a model
#                   failed, seed-golden-<seed>/golden-report.txt), journeys/
#                   and ts-mutants-*/
#   MUTANT_SHARDS   how many mutation shards the run started (0 or unset: none)
#   RUN_URL, COMMIT, BRANCH   what this run tested, written next to every row
#   GH_TOKEN        for `gh` (without it no issue is filed; file_issues.py prints
#                   what it would have done)
set -uo pipefail
: "${IN:?}" "${RUN_URL:?}" "${COMMIT:?}" "${BRANCH:?}"
MUTANT_SHARDS="${MUTANT_SHARDS:-0}"
short=$(echo "$COMMIT" | cut -c1-7)
today=$(date -u '+%Y-%m-%d %H:%M')

# Mutant names carry line:column, which move whenever code above them changes;
# "new survivor" compares names without them.
strip() { sed -E 's/^([^:]+):[0-9]+:[0-9]+:/\1:/' | sort -u; }

add_run() {
  found=0 new_missed=0 new_list=""
  [ -f log.csv ] || echo "finished,seed,cases,harness,oracle_bodies,disagreements,seconds,run,commit,branch" >log.csv
  # Logs from before the commit column was added: widen the header (their old
  # rows just leave the last two columns empty).
  head -1 log.csv | grep -q ',commit,branch$' || sed -i '1s/$/,commit,branch/' log.csv
  for d in "$IN"/endless-*/; do
    [ -d "$d" ] || continue
    [ -f "$d/log.csv" ] && tail -n +2 "$d/log.csv" | sed "s|\$|,$RUN_URL,$short,$BRANCH|" >>log.csv
    for f in "$d"seed-*; do
      [ -d "$f" ] || continue
      mkdir -p failures && cp -r "$f" failures/
      echo "tested commit $COMMIT on branch $BRANCH ($RUN_URL)" >"failures/$(basename "$f")/commit.txt"
      found=$((found + 1))
    done
  done

  if [ "$MUTANT_SHARDS" -gt 0 ]; then
    mkdir -p mutants
    [ -f mutants/log.csv ] || echo "finished,commit,branch,shards_finished,shards,caught,missed,timeout,unviable,new_missed,run" >mutants/log.csv
    finished=0 caught=0 timeout=0 unviable=0
    : >"$IN/missed-all.txt"
    for d in "$IN"/mutants-*/; do
      [ -d "$d" ] || continue
      # cargo mutants exits 0 (all caught), 2 (some missed) or 3 (some timed
      # out) when it got through its list; anything else (4: the unmutated
      # tests failed, 124/130: stopped at the deadline) means unfinished.
      case "$(cat "$d/exit-code.txt" 2>/dev/null)" in 0 | 2 | 3) finished=$((finished + 1)) ;; esac
      caught=$((caught + $(cat "$d/caught.txt" 2>/dev/null | grep -c .)))
      timeout=$((timeout + $(cat "$d/timeout.txt" 2>/dev/null | grep -c .)))
      unviable=$((unviable + $(cat "$d/unviable.txt" 2>/dev/null | grep -c .)))
      cat "$d/missed.txt" >>"$IN/missed-all.txt" 2>/dev/null
    done
    sort -u "$IN/missed-all.txt" -o "$IN/missed-all.txt"
    missed=$(grep -c . "$IN/missed-all.txt")
    if [ "$finished" = "$MUTANT_SHARDS" ]; then
      # Only a complete run replaces the list the next night compares with,
      # and the first complete run only sets it.
      if [ -f mutants/missed.txt ]; then
        new_list=$(comm -13 <(strip <mutants/missed.txt) <(strip <"$IN/missed-all.txt"))
        new_missed=$(printf '%s' "$new_list" | grep -c .)
      fi
      cp "$IN/missed-all.txt" mutants/missed.txt
      echo "tested commit $COMMIT on branch $BRANCH ($RUN_URL), $today UTC" >mutants/commit.txt
    fi
    echo "$today,$short,$BRANCH,$finished,$MUTANT_SHARDS,$caught,$missed,$timeout,$unviable,$new_missed,$RUN_URL" >>mutants/log.csv
  fi

  # The magic-moment journeys against tests/baseline.json: the latest run's
  # lines, and every FLAG line ever in journeys/flags.txt.
  if [ -f "$IN/journeys/report.txt" ]; then
    mkdir -p journeys
    { echo "tested commit $short on $BRANCH, $today UTC ($RUN_URL)"; cat "$IN/journeys/report.txt"; } >journeys/latest.txt
    grep '^FLAG' "$IN/journeys/report.txt" | sed "s|^|$today,$short,$BRANCH,|" >>journeys/flags.txt
  elif [ -d journeys ]; then
    echo "tested commit $short on $BRANCH, $today UTC ($RUN_URL)"$'\n'"no report: the journeys job stopped before the walk" >journeys/latest.txt
  fi

  # The golden models (step 28b): the latest night's lines, every night's
  # first line in golden/log.txt, and a failing night's folder in failures/
  # like a failing round's (file_issues.py files its kinds).
  if [ -f "$IN/golden/report.txt" ]; then
    mkdir -p golden
    { echo "tested commit $short on $BRANCH, $today UTC ($RUN_URL)"; cat "$IN/golden/report.txt"; } >golden/latest.txt
    echo "$today,$short,$BRANCH,$(head -1 "$IN/golden/report.txt")" >>golden/log.txt
  elif [ -d golden ]; then
    echo "tested commit $short on $BRANCH, $today UTC ($RUN_URL)"$'\n'"no report: the golden job stopped before the run" >golden/latest.txt
  fi
  for f in "$IN"/golden/seed-*; do
    [ -d "$f" ] || continue
    mkdir -p failures && cp -r "$f" failures/
    echo "tested commit $COMMIT on branch $BRANCH ($RUN_URL)" >"failures/$(basename "$f")/commit.txt"
    found=$((found + 1))
  done

  # TypeScript mutation testing: the latest run's survivor lines, one target per job.
  mkdir -p ts-mutants
  {
    echo "tested commit $short on $BRANCH, $today UTC ($RUN_URL)"
    for t in core design storage model svg viewport ai; do
      if [ -s "$IN/ts-mutants-$t/$t.txt" ]; then cat "$IN/ts-mutants-$t/$t.txt"; else echo "$t: no report (the job stopped before the check)"; fi
    done
  } >ts-mutants/latest.txt

  awk -F, -v now="$today UTC" 'NR > 1 {
      rounds++; cases += $3; fails += ($4 == "FAIL"); bodies += $5; dis += $6; secs += $7
      if ($4 == "FAIL" || $6 > 0) last = $1 " (seed " $2 ($9 ? ", commit " $9 " on " $10 : "") ")"
    } END {
      print "SpindleLabs random testing, all runs so far (updated " now ")"
      print ""
      printf "hours of testing:                 %.1f\n", secs / 3600
      print  "rounds:                           " rounds
      print  "random operation chains:          " cases
      print  "rounds where the harness failed:  " fails
      print  "bodies compared with OpenCascade: " bodies
      print  "OpenCascade disagreements:        " dis
      print  "last problem found:               " (last ? last : "none yet")
      print ""
      print "Every round is a line in log.csv. Each round that found a problem has a"
      print "folder in failures/ named after its seed: report.txt says what went wrong,"
      print "the .json file is the shortest chain of operations that shows it, and"
      print "failure-dumps/*/index.html is a 3D view with the problem in red."
      print "The commit and branch columns of log.csv (and commit.txt in each"
      print "failures folder) say which code a round tested."
    }' log.csv >summary.txt
  # The fuzzing section (collect-fuzz.sh) stays at the end.
  [ -f fuzz/summary.txt ] && { echo; cat fuzz/summary.txt; } >>summary.txt.fuzz
  if [ -f mutants/log.csv ]; then
    tail -1 mutants/log.csv | awk -F, '{
      print ""
      print "Latest mutation run (whole kernel, lib tests), " $1 " UTC, commit " $2 " on " $3 ":"
      print "  shards finished: " $4 " of " $5 ($4 == $5 ? "" : " (incomplete: survivors list not replaced)")
      print "  caught " $6 ", missed " $7 ", timed out " $8 ", unviable " $9
      print "  survivors not in the previous complete run: " $10
      print "mutants/missed.txt lists every survivor; mutants/log.csv has one line per night."
    }' >>summary.txt
  fi
  if [ -f journeys/latest.txt ]; then
    { echo ""; echo "Latest magic-moment journeys against tests/baseline.json (FLAG: an extra click, or the slowest walk more than 15% over):"; sed 's/^/  /' journeys/latest.txt; echo "journeys/flags.txt lists every FLAG line so far."; } >>summary.txt
  fi
  if [ -f golden/latest.txt ]; then
    { echo ""; echo "Latest golden models run (tests/golden rebuilt and checked against their hand-worked answers, timed against tests/baseline.json; a failing model files a random-testing issue):"; sed 's/^/  /' golden/latest.txt; echo "golden/log.txt has one line per night."; } >>summary.txt
  fi
  if [ -f ts-mutants/latest.txt ]; then
    { echo ""; echo "Latest TypeScript mutation run (packages/testing/stryker, survivors must be killed or explained):"; sed 's/^/  /' ts-mutants/latest.txt; } >>summary.txt
  fi
  if [ -f summary.txt.fuzz ]; then cat summary.txt.fuzz >>summary.txt; rm summary.txt.fuzz; fi
}

git config user.name "github-actions[bot]"
git config user.email "41898283+github-actions[bot]@users.noreply.github.com"
pushed=0
for attempt in 1 2 3 4 5; do
  git branch -qD test-results 2>/dev/null
  if git fetch -q origin test-results 2>/dev/null; then
    git checkout -qf -B test-results FETCH_HEAD
  else
    git switch -qf --orphan test-results
  fi
  git clean -fdq
  add_run
  git add -A .
  if git diff --cached --quiet; then pushed=1; break; fi
  git commit -qm "Random testing run $(basename "$RUN_URL"): $found round(s) found something, $new_missed new mutation survivor(s)"
  if git push -q origin test-results; then pushed=1; break; fi
  echo "Push refused (attempt $attempt); starting again from the branch as it is now."
  sleep $((2 ** attempt))
done
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat summary.txt >>"$GITHUB_STEP_SUMMARY"
[ $pushed = 1 ] || { echo "Could not push to test-results after 5 attempts."; exit 1; }

# One issue per kind of problem, found again and updated rather than piling
# up (file_issues.py, next to this script).
if [ "$found" -gt 0 ]; then
  RUN_URL="$RUN_URL" COMMIT="$short" BRANCH="$BRANCH" python3 "$(dirname "$0")/file_issues.py" "$IN" ||
    echo "Filing issues failed; the results are on test-results all the same."
fi
if [ "$new_missed" -gt 0 ]; then
  body="Run: $RUN_URL (commit $short on $BRANCH)"$'\n\n'
  body="$body$new_missed mutant(s) survived that the previous complete mutation run caught or did not have (new code, or a test that got weaker):"$'\n'"$(printf '%s\n' "$new_list" | head -50 | sed 's/^/- /')"$'\n\n'"Every survivor is in mutants/missed.txt on the test-results branch."$'\n'
  title="Mutation testing: $new_missed new survivor(s)"
  if [ -n "${GH_TOKEN:-}" ]; then gh issue create --title "$title" --body "$body"; else printf '%s\n\n%s' "$title" "$body"; fi
fi
