#!/usr/bin/env bash
# Network preparation on a disposable, public-source GitHub runner only.
set -euo pipefail
umask 077
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$(. /etc/os-release; printf '%s' "$VERSION_ID")" = 24.04
if [ "$#" -ne 3 ]; then
  printf 'Usage: prepare-media.sh NEW_WORK_DIR V08_INPUT_DIR BUNDLE_EXTRACTOR\n' >&2
  exit 2
fi
task_scripts="$(cd "$(dirname "$0")" && pwd)"
task_work="$1"
task_input="$2"
task_extractor="$3"
test ! -e "$task_work"
mkdir -m 700 "$task_work"
mkdir -m 700 "$task_work/home"
python3 "$task_scripts/media-tools.py" fetch "$task_work" "$task_scripts/source-lock.json"
python3 "$task_scripts/media-tools.py" check-input "$task_input" "$task_scripts/source-lock.json"
python3 "$task_extractor" extract "$task_input" "$task_work/candidate"
(
  cd "$task_work/candidate"
  env -i PATH="$PATH" HOME="$task_work/home" LANG=C.UTF-8 CI=true \
    NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_userconfig=/dev/null npm_config_cache="$task_work/npm-cache" \
    npm ci --ignore-scripts --no-audit --no-fund
)
python3 "$task_scripts/media-tools.py" check-tree "$task_work/candidate" "$task_input"
