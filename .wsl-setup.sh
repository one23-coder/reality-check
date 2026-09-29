#!/usr/bin/env bash
# Linux (WSL) browser-dependency bootstrap + full verification, no root required.
set -u
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null
mkdir -p ~/libs/debs && cd ~/libs/debs && rm -f ./*.deb

fetch() { # pool-dir prefix
  local url
  url=$(curl -s "http://archive.ubuntu.com/ubuntu/pool/$1/" \
    | grep -oE "href=\"[^\"]*$2[^\"]*amd64\.deb\"" \
    | cut -d'"' -f2 | sort -V | tail -1)
  echo "fetch: $url"
  [ -n "$url" ] && curl -sO "http://archive.ubuntu.com/ubuntu/pool/$1/$url"
}
fetch main/a/alsa-lib libasound2t64_
fetch main/n/nspr libnspr4_
fetch main/n/nss libnss3_

mkdir -p ~/libs/root
for f in ./*.deb; do dpkg -x "$f" ~/libs/root; done
export LD_LIBRARY_PATH="$HOME/libs/root/usr/lib/x86_64-linux-gnu"

echo "=== missing-libs count (want 0)"
ldd "$HOME/.cache/ms-playwright/chromium-1194/chrome-linux/chrome" 2>&1 | grep -c "not found"

cd ~/rc-verify
echo "=== npm test"
npm test 2>&1 | grep -E "^# (tests|suites|pass|fail)"
echo "=== cli run"
node packages/cli/dist/src/main.js run scenarios/booking-normal.json 2>&1 | grep -E "^run |^held|^violated"
RID=$(ls -t runs | head -1)
echo "=== rerun"
node packages/cli/dist/src/main.js rerun --run-id "$RID" 2>&1 | grep "^rerun"
echo "=== export lines"
node packages/cli/dist/src/main.js export 2>&1 | grep -cE "^rc-"
echo ALL_DONE
