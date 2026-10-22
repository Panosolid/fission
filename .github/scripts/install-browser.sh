#!/usr/bin/env bash
# Installs one Playwright browser and the system packages it needs, for the
# browser checks in .github/workflows/ci.yml and nightly.yml. Run from
# apps/fission (where playwright is installed).
#
# `npx playwright install --with-deps` runs apt-get, which can stall on the
# Ubuntu mirror (it hung #251's and #252's runs for 13 minutes). So apt
# retries each download and gives up on a silent one after 30 s, and each
# half gets INSTALL_SECONDS (default 300) per try, three tries in all. The
# packages are installed by a `timeout` running as root: timeout signals its
# whole process group, and only root may signal the apt-get it starts (as the
# runner user, the killed attempt left apt-get running, holding the dpkg lock
# the next try then failed on). A killed install is repaired with
# `dpkg --configure -a` before the next try, and apt waits up to 120 s for a
# lock still held. The browser itself downloads as the runner user, into its
# own cache, as before.
#
# Usage: install-browser.sh <chromium|firefox|webkit>
set -u
browser=$1
seconds=${INSTALL_SECONDS:-300}

printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nDPkg::Lock::Timeout "120";\n' \
  | sudo tee /etc/apt/apt.conf.d/80-retries > /dev/null

for try in 1 2 3; do
  if sudo env "PATH=$PATH" timeout -k 15 "$seconds" npx playwright install-deps "$browser" \
    && timeout -k 15 "$seconds" npx playwright install "$browser"; then
    exit 0
  fi
  echo "install-browser: try $try of 3 failed" >&2
  [ "$try" = 3 ] && exit 1
  sudo dpkg --configure -a || true
  sleep 15
done
