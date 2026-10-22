#!/usr/bin/env bash
# Installs one Playwright browser and the system packages it needs, for the
# browser checks in .github/workflows/ci.yml and nightly.yml. Run from
# apps/fission (where playwright is installed).
#
# `npx playwright install --with-deps` runs apt-get, which can stall on the
# Ubuntu mirror (it hung #251's and #252's runs for 13 minutes). So apt
# retries each download and gives up on a silent connection after 30 s (a
# stall limit, not a total one: a slow mirror that keeps sending, like
# azure.archive.ubuntu.com at ~2 min per 9 MB file on 2026-10-22, is left to
# finish). The packages get PACKAGE_SECONDS (default 720) a try and the
# browser download BROWSER_SECONDS (default 300), three tries in all, but the
# whole script never runs past TOTAL_SECONDS (default 1500): each limit is cut
# to what is left of it, so a dead mirror fails the job in 25 minutes at most.
# Tries 2 and 3 switch apt from the Azure mirror to archive.ubuntu.com, in
# case that mirror is the slow one. The packages are installed by a `timeout`
# running as root: timeout signals its whole process group, and only root may
# signal the apt-get it starts (as the runner user, the killed attempt left
# apt-get running, holding the dpkg lock the next try then failed on). A killed
# install is repaired with `dpkg --configure -a` before the next try, and apt
# waits up to 120 s for a lock still held. The browser itself downloads as the
# runner user, into its own cache, as before.
#
# Usage: install-browser.sh <chromium|firefox|webkit>
set -u
browser=$1
package_seconds=${PACKAGE_SECONDS:-720}
browser_seconds=${BROWSER_SECONDS:-300}
total_seconds=${TOTAL_SECONDS:-1500}
start=$SECONDS

printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nDPkg::Lock::Timeout "120";\n' \
  | sudo tee /etc/apt/apt.conf.d/80-retries > /dev/null

# The smaller of a per-step limit and the time left in the total budget (at
# least 1 s, so `timeout` always gets a positive number).
limit() {
  local left=$((total_seconds - (SECONDS - start)))
  [ "$left" -lt 1 ] && left=1
  [ "$1" -lt "$left" ] && echo "$1" || echo "$left"
}

for try in 1 2 3; do
  if [ "$try" -gt 1 ]; then
    sudo sh -c 'sed -i "s#azure\.archive\.ubuntu\.com#archive.ubuntu.com#g" /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null; true'
  fi
  if sudo env "PATH=$PATH" timeout -k 15 "$(limit "$package_seconds")" npx playwright install-deps "$browser" \
    && timeout -k 15 "$(limit "$browser_seconds")" npx playwright install "$browser"; then
    exit 0
  fi
  echo "install-browser: try $try of 3 failed" >&2
  [ "$try" = 3 ] && exit 1
  [ $((SECONDS - start)) -ge "$total_seconds" ] && { echo "install-browser: out of time" >&2; exit 1; }
  sudo dpkg --configure -a || true
  sleep 15
done
