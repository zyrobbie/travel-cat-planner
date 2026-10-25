#!/usr/bin/env bash
set -euo pipefail

task_scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_source="${RUNNER_TEMP:?}/e4e-linux-source"
task_output="${RUNNER_TEMP:?}/e4e-linux-artifacts"
task_input="${GITHUB_WORKSPACE:?}/voice-build-input"
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$(node --version)" = v22.23.3
test "${E4E_BUILD_COMMIT:?}" = "${GITHUB_SHA:?}"

case "${1:-}" in
  install)
    python3 "$task_scripts/bundle.py" extract "$task_input" "$task_source"
    mkdir -m 700 "$task_output"
    # Only public npm packages from the frozen lockfile. No npm/GitHub/cloud
    # credential environment reaches npm or the lifecycle scripts.
    cd "$task_source"
    env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 CI=true \
      NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      npm_config_userconfig=/dev/null npm_config_cache="$RUNNER_TEMP/e4e-npm-cache" \
      npm ci --no-audit --no-fund > "$task_output/npm-ci.log" 2>&1 || {
        tail -80 "$task_output/npm-ci.log"; exit 1;
      }
    ;;
  offline-build)
    # This network namespace has loopback only: Next/Vite/typecheck and the
    # anonymous local smoke check cannot reach ASR, mail, cloud DBs or APIs.
    sudo -n unshare --net -- bash -c '
      set -euo pipefail
      ip link set lo up
      exec setpriv --reuid="$1" --regid="$2" --init-groups \
        env -i PATH="$3" HOME="$4" LANG=C.UTF-8 \
        E4E_BUILD_COMMIT="$5" python3 "$6" build "$7" "$8"
    ' bash "$(id -u)" "$(id -g)" "$PATH" "$HOME" "$E4E_BUILD_COMMIT" \
      "$task_scripts/bundle.py" "$task_source" "$task_output"
    python3 "$task_scripts/bundle.py" verify "$task_output"
    ;;
  *) printf '%s\n' 'Use install or offline-build.' >&2; exit 2 ;;
esac
