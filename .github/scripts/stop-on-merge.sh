#!/usr/bin/env bash
# Used by .github/workflows/nightly.yml beside run-until.sh, in random testing
# started from a push (workflow_dispatch on a branch): once the branch's pull
# request has merged or closed, creates the stop file endless.sh watches
# (FISSION_ENDLESS_STOP_FILE), so the round in progress finishes and is kept,
# no new round starts, and the run's results are collected as usual. Tonight's
# run on main tests the merged code; this frees the runners (owner's decision,
# 2026-10-17). A branch with no pull request yet, or with one open, keeps
# testing; a failed lookup just waits for the next one.
#
# Usage: stop-on-merge.sh <branch> <stop file>
# Asks every STOP_POLL_SECONDS (default 300); needs GH_TOKEN and GITHUB_REPOSITORY.
set -u
branch=$1 stop_file=$2
while sleep "${STOP_POLL_SECONDS:-300}"; do
  # Only pull requests from this repository: a fork's pull request from a
  # branch with the same name must not stop our run.
  states=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --state all --json state,headRepositoryOwner \
    --jq ".[] | select(.headRepositoryOwner.login == \"${GITHUB_REPOSITORY%%/*}\") | .state") || continue
  if [ -n "$states" ] && ! grep -qx OPEN <<<"$states"; then
    echo "The pull request for $branch has merged or closed: random testing stops after the round in progress."
    touch "$stop_file"
    exit 0
  fi
done
