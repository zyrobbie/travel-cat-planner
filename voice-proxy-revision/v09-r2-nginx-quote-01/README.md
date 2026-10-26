# v09-r2-nginx-quote-01

Reviewed deployment configuration revision. The original complete Linux runtime remains immutable; Next is not rebuilt. The one-line nginx fix quotes the request UUID regular expression. The independent proxy unit only changes WorkingDirectory to the reviewed revision, where the original guard still executes and compares the exact revised template. The app, database services and their current release remain unchanged.

Original build commit: `4bd4cb45b68019a192c7eb3e9fb1254dff52bbb3`.
Original complete runtime SHA256: `6114cfa33f50bff5a6edc43b44cbdeab1edc73151a9f8659b8303d1d12ce7b14`.

## Linux syntax validation

On an ephemeral Ubuntu 24.04 GitHub Actions runner, install nginx-core and openssl, then run `bash voice-proxy-revision/v09-r2-nginx-quote-01/check-nginx-quote-01.sh`. The script refuses non-GitHub/non-Linux execution, refuses existing target directories, generates only a disposable self-signed test certificate, reproduces the original parser failure, and tests the exact revised full nginx configuration. It starts no nginx listener or application. Do not upload certificates or private keys; runner disposal removes them. This syntax check does not establish a working production deployment or real voice/email acceptance.

## Reviewed server operation

Root coordinator only: verify MANIFEST.json hashes, then run `sudo python3 06-resume-proxy-quote-01.py` (read-only). Explicit `--apply` performs one recovery attempt using the already-issued independent certificate, without certbot. `--rollback` stops only the new proxy/mount and restores the precise two non-secret config backups. No secrets are included here; mail.env/provider.env may already exist and are neither read nor removed. There is no app restart, resource-limit relaxation, boot enabling, DNS/firewall change, or voice/email enablement.

The script verifies the entire original runtime archive and all deployed regular files/symlinks, creates a root-owned configuration revision with fixed links to that runtime, keeps the original guard and 64MiB cap, and records protected old/new app/database PIDs before and after. Failed runs preserve evidence and do not automatically retry. The original failed installer must not be rerun.
