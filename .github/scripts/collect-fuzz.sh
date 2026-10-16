#!/usr/bin/env bash
# Adds one "Fuzzing" run to the test-results branch: every round's line to
# fuzz/log.csv, failure folders to fuzz/failures/seed-<seed>/, rewrites
# fuzz/summary.txt (and its section at the end of summary.txt, which
# collect-results.sh also appends after rewriting the rest), then files one
# issue per kind of problem (file_issues.py, next to this script). Called by
# the collect job in .github/workflows/fuzz.yml, from a checkout with full
# history. A refused push starts again from the branch as it now is, like
# collect-results.sh (the inputs are all in $IN, so applying twice is safe).
#
# Environment:
#   IN                        downloaded artifacts: fuzz-<target>/ (log.csv, seed-*/)
#   RUN_URL, COMMIT, BRANCH   what this run tested, written next to every row
#   GH_TOKEN                  for `gh` (without it file_issues.py only prints)
set -uo pipefail
: "${IN:?}" "${RUN_URL:?}" "${COMMIT:?}" "${BRANCH:?}"
short=$(echo "$COMMIT" | cut -c1-7)
today=$(date -u '+%Y-%m-%d %H:%M')

add_run() {
  found=0
  mkdir -p fuzz
  [ -f fuzz/log.csv ] || echo "target,seed,cases,failures,seconds,run,commit,branch" >fuzz/log.csv
  for d in "$IN"/fuzz-*/; do
    [ -d "$d" ] || continue
    [ -f "$d/log.csv" ] && tail -n +2 "$d/log.csv" | sed "s|\$|,$RUN_URL,$short,$BRANCH|" >>fuzz/log.csv
    for f in "$d"seed-*; do
      [ -d "$f" ] || continue
      mkdir -p fuzz/failures && cp -r "$f" fuzz/failures/
      echo "tested commit $COMMIT on branch $BRANCH ($RUN_URL)" >"fuzz/failures/$(basename "$f")/commit.txt"
      found=$((found + 1))
    done
  done
  awk -F, -v now="$today UTC" 'NR > 1 {
      rounds[$1]++; cases[$1] += $3; bad[$1] += ($4 > 0); secs += $5
      if ($4 > 0) last[$1] = $2 " (commit " $7 " on " $8 ")"
    } END {
      print "Fuzzing (the STL reader and the project loader), all runs so far (updated " now ")"
      printf "  hours of fuzzing: %.1f\n", secs / 3600
      for (t in rounds) printf "  %-8s rounds %d, inputs %d, rounds that found something %d, last: %s\n", t, rounds[t], cases[t], bad[t], (t in last ? last[t] : "none yet")
      print "fuzz/log.csv has one line per round; fuzz/failures/seed-<seed>/ has each failing round'\''s"
      print "fuzz-report.txt and its shrunk failing inputs."
    }' fuzz/log.csv >fuzz/summary.txt
  # summary.txt: the random-testing part (everything before the fuzzing
  # section) stays as collect-results.sh wrote it.
  if [ -f summary.txt ]; then
    awk '/^Fuzzing \(the STL reader/ { exit } { print }' summary.txt >summary.new
    sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' summary.new
    mv summary.new summary.txt
    echo >>summary.txt
  fi
  cat fuzz/summary.txt >>summary.txt
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
  git commit -qm "Fuzzing run $(basename "$RUN_URL"): $found round(s) found something"
  if git push -q origin test-results; then pushed=1; break; fi
  echo "Push refused (attempt $attempt); starting again from the branch as it is now."
  sleep $((2 ** attempt))
done
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat fuzz/summary.txt >>"$GITHUB_STEP_SUMMARY"
[ $pushed = 1 ] || { echo "Could not push to test-results after 5 attempts."; exit 1; }

if [ "$found" -gt 0 ]; then
  RUN_URL="$RUN_URL" COMMIT="$short" BRANCH="$BRANCH" python3 "$(dirname "$0")/file_issues.py" "$IN" ||
    echo "Filing issues failed; the results are on test-results all the same."
fi
