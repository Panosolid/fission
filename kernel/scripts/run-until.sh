#!/usr/bin/env bash
# Used by .github/workflows/nightly.yml: endless.sh rounds (2000 cases each, the
# OpenCascade oracle through `python`) until the earlier of the deadline $1
# (unix time) and 315 minutes from now, then a hard stop. A GitHub job may last
# 6 hours; the margin covers setup, the build, the last round and the upload.
set -uo pipefail
cd "$(dirname "$0")/.."
now=$(date +%s)
until=$(( $1 < now + 315 * 60 ? $1 : now + 315 * 60 ))
if [ $(( until - now )) -lt 900 ]; then
  echo "Less than 15 minutes before the deadline: no rounds this time."
  exit 0
fi
echo "Rounds start until $(date -u -d "@$until" '+%F %H:%M UTC')."
# endless.sh starts no round after $until. A round takes about 5 minutes, so
# one still running 10 minutes later is stopped and thrown away (endless.sh
# discards an interrupted round), which keeps the deadline hard.
code=0
FISSION_ENDLESS_UNTIL=$until timeout -s INT -k 60 $(( until - now + 600 )) \
  scripts/endless.sh 2000 0 python || code=$?
if [ $code = 124 ] || [ $code = 137 ]; then
  echo "Stopped at the hard limit; the unfinished round was thrown away."
  code=0
fi
exit $code
