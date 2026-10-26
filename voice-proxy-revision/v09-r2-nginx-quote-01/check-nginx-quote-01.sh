#!/usr/bin/env bash
# Ephemeral GitHub Linux runner ONLY. Not a production deployment script.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
test -n "${RUNNER_TEMP:-}"
command -v nginx >/dev/null
command -v openssl >/dev/null
catvoice_source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
catvoice_config="$catvoice_source_dir/nginx-v09-r2-quote-01.conf"
catvoice_temp=$(mktemp -d "$RUNNER_TEMP/catvoice-nginx-quote01.XXXXXX")
# Do not overwrite an existing environment, even on a runner.
sudo test ! -e /etc/cat-voice-test
sudo test ! -e /run/cat-voice-proxy
sudo install -d -m 0755 /etc/cat-voice-test/proxy /run/cat-voice-proxy
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=cat-test.zyrobbie.site \
  -keyout /etc/cat-voice-test/proxy/privkey.pem \
  -out /etc/cat-voice-test/proxy/fullchain.pem >/dev/null 2>&1
printf 'return 503;\n' | sudo tee /etc/cat-voice-test/proxy/entry-gate.conf >/dev/null
printf 'return 503;\n' | sudo tee /etc/cat-voice-test/proxy/voice-gate.conf >/dev/null
python3 - "$catvoice_config" "$catvoice_temp/original.conf" <<'PY'
import hashlib,pathlib,sys
p=pathlib.Path(sys.argv[1]);b=p.read_bytes()
assert hashlib.sha256(b).hexdigest()=='7ff0a69d28ad2de8f70f428fab5ac64ff64983b9f1f4423b270c931889e191a6'
s=b.decode();quoted='location ~ "^/api/e4/requests/[a-f0-9-]{36}$"'
assert s.count(quoted)==1
old=s.replace(quoted,'location ~ ^/api/e4/requests/[a-f0-9-]{36}$')
assert hashlib.sha256(old.encode()).hexdigest()=='dbccfdb227751d1072e343ba17328743cc10746815b7a0f0e170ad815ad106aa'
pathlib.Path(sys.argv[2]).write_text(old)
PY
if sudo nginx -t -c "$catvoice_temp/original.conf" -p /run/cat-voice-proxy/ >"$catvoice_temp/original.log" 2>&1; then
  echo 'FAIL: original defective config unexpectedly passed' >&2
  exit 1
fi
python3 - "$catvoice_temp/original.log" <<'PY'
import pathlib,sys
assert 'unknown directive "36}$"' in pathlib.Path(sys.argv[1]).read_text()
PY
sudo nginx -t -c "$catvoice_config" -p /run/cat-voice-proxy/ >"$catvoice_temp/revised.log" 2>&1
echo 'PASS: original braces regression reproduced; exact revised nginx config parses.'
echo 'No nginx listener started; no app build, ASR, email, account, or cloud access.'
# Runner disposal removes the synthetic certificate; never upload /etc or keys.
