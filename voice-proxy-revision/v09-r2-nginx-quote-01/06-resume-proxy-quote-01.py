#!/usr/bin/env python3
"""Reviewed deployment-config revision, NOT a rebuilt Next/application release.

Default: read-only verification. --apply: one attempt, existing new certificate.
Keeps the frozen runtime and guard intact. Never reads secret env/key files,
calls certbot, enables boot startup, restarts the app, or opens voice/mail.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import tarfile
import urllib.request

ROOT = Path('/srv/cat-voice-test')
RELEASE = ROOT / 'releases/v09-r2-4bd4cb45b680'
ARCHIVE = ROOT / 'resume-v09-r2/reviewed-runtime.tar.gz'
ARCHIVE_SHA = '6114cfa33f50bff5a6edc43b44cbdeab1edc73151a9f8659b8303d1d12ce7b14'
COMMIT = '4bd4cb45b68019a192c7eb3e9fb1254dff52bbb3'
REVISION = ROOT / 'proxy-revisions/v09-r2-nginx-quote-01'
STATE = ROOT / 'proxy-recovery-v09-r2-quote-01'
CONFIG = Path('/etc/cat-voice-test/proxy/nginx.conf')
UNIT = Path('/etc/systemd/system/cat-voice-proxy.service')
PROXY = 'cat-voice-proxy.service'
MOUNT = 'run-cat\\x2dvoice\\x2dproxy.mount'
SOURCE = RELEASE / 'deploy/private-voice/linux'
CONFIG_BEFORE = 'dbccfdb227751d1072e343ba17328743cc10746815b7a0f0e170ad815ad106aa'
CONFIG_AFTER = '7ff0a69d28ad2de8f70f428fab5ac64ff64983b9f1f4423b270c931889e191a6'
UNIT_BEFORE = '8b3c55f5dbb6ad9309f6fa35787c252b0c7eae7975556be94d01b04479ee5e17'
UNIT_AFTER = '52d8d5f1e6861d489dbec60e34cbde16d79e8ee09d437f81b858c1c049eea318'
ENV = {'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/nonexistent', 'LANG': 'C.UTF-8'}
phase = 'precheck'


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def run(args, timeout=30, check=True):
    r = subprocess.run(args, capture_output=True, env=ENV, timeout=timeout)
    if check:
        need(r.returncode == 0, 'COMMAND_FAILED_' + phase)
    return r


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def props(unit):
    r = run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'UnitFileState'], check=False)
    need(r.returncode == 0, 'UNIT_METADATA_UNAVAILABLE')
    return dict(x.split('=', 1) for x in r.stdout.decode().splitlines())


def snapshot():
    services = ['nginx.service', 'cat-letters.service', 'cat-voice-app.service',
                'cat-voice-business.service', 'cat-voice-ledger.service',
                'cat-letters-background.timer', 'cat-letters-background-expiry.timer']
    units = {name: props(name) for name in services}
    need(all(p['ActiveState'] == 'active' for p in units.values()), 'PROTECTED_UNIT_NOT_ACTIVE')
    need(units['nginx.service'].get('MainPID') == '248987' and
         units['cat-letters.service'].get('MainPID') == '316530', 'OLD_PID_CHANGED')
    pid = int(units['cat-voice-app.service']['MainPID'])
    need(pid > 0 and Path('/proc/' + str(pid) + '/cwd').resolve() == RELEASE, 'NEW_APP_RELEASE_CHANGED')
    cert = run(['openssl', 'x509', '-in', '/etc/letsencrypt/live/cat-test.zyrobbie.site/fullchain.pem', '-outform', 'DER']).stdout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:3100/api/health', timeout=8) as response:
        need(response.status == 200 and json.loads(response.read(4096)).get('status') == 'ok', 'OLD_HEALTH_FAILED')
    return {'units': units, 'links': {str(p): os.readlink(p) for p in [
        ROOT / 'current', Path('/srv/cat-letters/current'), Path('/srv/cat-letters/background-current')]},
        'oldConfigSha': sha('/etc/nginx/sites-available/cat-letters'),
        'oldPublicCertificateSha': hashlib.sha256(cert).hexdigest()}


def verify_full_runtime():
    need(sha(ARCHIVE) == ARCHIVE_SHA, 'ORIGINAL_COMPLETE_RUNTIME_ARCHIVE_CHANGED')
    expected = set()
    with tarfile.open(ARCHIVE, 'r:gz') as archive:
        for member in archive:
            need(member.name.startswith('cat-voice-runtime/'), 'ARCHIVE_ROOT_CHANGED')
            relative = member.name[len('cat-voice-runtime/'):]
            need(relative and '..' not in Path(relative).parts and not Path(relative).is_absolute(), 'ARCHIVE_PATH_INVALID')
            path = RELEASE / relative
            expected.add(relative)
            info = path.lstat()
            need(info.st_uid == 0 and info.st_gid == 0 and
                 (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), 'RUNTIME_METADATA_CHANGED')
            if member.issym():
                need(path.is_symlink() and os.readlink(path) == member.linkname and
                     path.resolve().is_relative_to(RELEASE), 'RUNTIME_LINK_CHANGED')
            else:
                need(member.isfile() and stat.S_ISREG(info.st_mode) and path.resolve().is_relative_to(RELEASE), 'RUNTIME_TYPE_CHANGED')
                h = hashlib.sha256()
                with archive.extractfile(member) as data:
                    for block in iter(lambda: data.read(1024 * 1024), b''):
                        h.update(block)
                need(sha(path) == h.hexdigest(), 'RUNTIME_FILE_CHANGED')
    actual = set()
    for directory, folders, files in os.walk(RELEASE, followlinks=False):
        for name in folders[:]:
            path = Path(directory) / name
            if path.is_symlink():
                actual.add(str(path.relative_to(RELEASE))); folders.remove(name)
        actual.update(str((Path(directory) / name).relative_to(RELEASE)) for name in files)
    need(actual == expected, 'RUNTIME_FILE_SET_CHANGED')
    return len(expected)


def patched_texts():
    original = (SOURCE / 'nginx.conf').read_text()
    old = 'location ~ ^/api/e4/requests/[a-f0-9-]{36}$ { proxy_pass http://catvoice_app; }'
    new = 'location ~ "^/api/e4/requests/[a-f0-9-]{36}$" { proxy_pass http://catvoice_app; }'
    need(original.count(old) == 1, 'EXPECTED_SINGLE_LINE_ABSENT')
    config = original.replace(old, new).encode()
    unit = (SOURCE / PROXY).read_text().replace('WorkingDirectory=/srv/cat-voice-test/current',
                                             'WorkingDirectory=' + str(REVISION)).encode()
    need(hashlib.sha256(config).hexdigest() == CONFIG_AFTER and
         hashlib.sha256(unit).hexdigest() == UNIT_AFTER, 'PATCH_SCOPE_CHANGED')
    return config, unit


def precheck():
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    need((ROOT / 'current').resolve() == RELEASE, 'CURRENT_RELEASE_CHANGED')
    need(not STATE.exists() and not REVISION.exists(), 'ONE_TIME_REVISION_ALREADY_EXISTS')
    for path, expected in [(CONFIG, CONFIG_BEFORE), (UNIT, UNIT_BEFORE),
                           (SOURCE / 'nginx.conf', CONFIG_BEFORE), (SOURCE / PROXY, UNIT_BEFORE)]:
        need(not path.is_symlink() and sha(path) == expected, 'EXPECTED_ORIGINAL_CHANGED')
    for unit in [PROXY, MOUNT]:
        p = props(unit)
        need(p['ActiveState'] == 'inactive' and p['UnitFileState'] == 'disabled', 'NEW_PROXY_NOT_STOPPED_DISABLED')
    base = CONFIG.parent
    need(json.loads((base / 'entry-state.json').read_text()) == {'entry':'closed','voice':'disabled'}, 'ENTRY_NOT_CLOSED')
    for name in ['entry-gate.conf', 'voice-gate.conf']:
        need(sha(base / name) == sha(SOURCE / name), 'CLOSED_GATE_CHANGED')
    user = pwd.getpwnam('catvoice-proxy')
    for name in ['fullchain.pem', 'privkey.pem']:
        info = (base / name).lstat()  # Metadata only; nginx later loads its own new TLS key.
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == user.pw_gid and
             stat.S_IMODE(info.st_mode) == 0o640, 'NEW_TLS_METADATA_CHANGED')
    run(['openssl','x509','-in',str(base / 'fullchain.pem'),'-checkend','604800','-noout'])
    run(['openssl','x509','-in',str(base / 'fullchain.pem'),'-checkhost','cat-test.zyrobbie.site','-noout'])
    # mail.env/provider.env may now exist: no read, deletion, permission change,
    # or app restart. The proxy does not load these files.
    count = verify_full_runtime()
    config, unit = patched_texts()
    return snapshot(), count, config, unit, user


def write(path, content, mode, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as output:
        os.fchmod(output.fileno(), mode); os.fchown(output.fileno(), 0, gid)
        output.write(content); output.flush(); os.fsync(output.fileno())


def replace(path, content, mode, gid=0):
    temporary = path.with_name(path.name + '.quote01-new')
    write(temporary, content, mode, gid); os.replace(temporary, path)


def receipt(data):
    replace(STATE / 'receipt.json', (json.dumps(data, indent=2) + '\n').encode(), 0o600)


def rollback(record):
    run(['systemctl', 'stop', PROXY], check=False)
    run(['systemctl', 'stop', MOUNT], check=False)
    need(all(props(u)['ActiveState'] in ['inactive','failed'] for u in [PROXY,MOUNT]), 'STOP_FAILED')
    for target, backup, before, after, mode, gid in [
        (CONFIG, STATE / 'nginx.original', CONFIG_BEFORE, CONFIG_AFTER, 0o640, pwd.getpwnam('catvoice-proxy').pw_gid),
        (UNIT, STATE / 'proxy-unit.original', UNIT_BEFORE, UNIT_AFTER, 0o644, 0)]:
        need(sha(backup) == before and sha(target) in [before,after], 'ROLLBACK_FILE_CHANGED')
        replace(target, backup.read_bytes(), mode, gid)
    run(['systemctl','daemon-reload'])
    record['rolledBack'] = True
    receipt(record)


def apply(before, count, config, unit, user):
    global phase
    STATE.mkdir(mode=0o700)
    record = {'revision':'v09-r2-nginx-quote-01','type':'reviewed-deployment-config-revision',
              'commit':COMMIT,'originalCompleteRuntimeSha256':ARCHIVE_SHA,'verifiedRuntimeFiles':count,
              'protectedBefore':before,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'certificateReissued':False,'guardSkipped':False,'status':'STARTED'}
    write(STATE / 'nginx.original', CONFIG.read_bytes(), 0o600)
    write(STATE / 'proxy-unit.original', UNIT.read_bytes(), 0o600)
    receipt(record)
    try:
        phase = 'install_reviewed_config_revision'
        REVISION.parent.mkdir(mode=0o755, exist_ok=True)
        parent = REVISION.parent.lstat()
        need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022, 'REVISION_PARENT_UNSAFE')
        REVISION.mkdir(mode=0o755); REVISION.chmod(0o755)
        target = REVISION / 'deploy/private-voice/linux'
        target.mkdir(parents=True, mode=0o755)
        for folder in [REVISION/'deploy',REVISION/'deploy/private-voice',target]: folder.chmod(0o755)
        write(target / 'nginx.conf', config, 0o644)
        for name in ['scripts','src','node_modules']:
            (REVISION / name).symlink_to(RELEASE / name, target_is_directory=True)
        write(REVISION / 'REVISION.json', (json.dumps({
            'type':record['type'],'runtimeSha256':ARCHIVE_SHA,'commit':COMMIT,
            'nginxOriginalSha256':CONFIG_BEFORE,'nginxRevisedSha256':CONFIG_AFTER,
            'unitOriginalSha256':UNIT_BEFORE,'unitRevisedSha256':UNIT_AFTER,
            'guard':'unchanged fixed original runtime; full normal guard execution',
            'note':'Only quoted location regex and proxy WorkingDirectory differ; no Next rebuild.'},indent=2)+'\n').encode(),0o644)
        replace(CONFIG, config, 0o640, user.pw_gid)
        replace(UNIT, unit, 0o644)
        phase = 'verify_and_start_proxy_once'
        run(['systemd-analyze','verify',str(UNIT),str(UNIT.parent/MOUNT)])
        run(['systemctl','daemon-reload'])
        run(['systemctl','start',MOUNT],timeout=45)
        check = run(['runuser','-u','catvoice-proxy','--','/usr/sbin/nginx','-t','-c',str(CONFIG),'-p','/run/cat-voice-proxy/'],check=False)
        # Only this non-secret parser output is retained; no key contents/env.
        write(STATE/'nginx-test.log',check.stdout+check.stderr,0o600)
        need(check.returncode == 0,'REVISED_NGINX_SYNTAX_FAILED')
        run(['systemctl','start',PROXY],timeout=60)
        phase = 'verify_closed_tls_and_protected_pids'
        for route in ['/account-app/','/api/e4/voice/health']:
            result=run(['curl','--noproxy','*','-sS','--max-time','10','--resolve',
                'cat-test.zyrobbie.site:8443:127.0.0.1','-o','/dev/null','-w','%{http_code}',
                'https://cat-test.zyrobbie.site:8443'+route])
            need(result.stdout==b'503','CLOSED_TLS_NOT_503')
        need(props(PROXY)['ActiveState']=='active' and all(props(u)['UnitFileState']=='disabled' for u in [PROXY,MOUNT]),'NEW_UNIT_STATE_WRONG')
        need(snapshot()==before,'PROTECTED_STATE_CHANGED')
        need(sha(SOURCE/'nginx.conf')==CONFIG_BEFORE and sha(CONFIG)==sha(target/'nginx.conf')==CONFIG_AFTER,'CONFIG_BINDING_CHANGED')
        record.update(status='CLOSED_HTTPS_CONFIG_REVISION_PASS',entry='closed',voice='disabled',
                      oldAndNewAppPidsUnchanged=True,bootEnabled=False,public8443NotTested=True,
                      finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        receipt(record)
        return record
    except Exception as error:
        record.update(status='FAILED',phase=phase,errorCode=str(error) if isinstance(error,RuntimeError) else type(error).__name__)
        rollback(record)
        raise


def main():
    def interrupted(number,_frame): raise RuntimeError('INTERRUPTED_'+str(number))
    signal.signal(signal.SIGINT,interrupted); signal.signal(signal.SIGTERM,interrupted)
    parser=argparse.ArgumentParser()
    flags=parser.add_mutually_exclusive_group()
    flags.add_argument('--apply',action='store_true'); flags.add_argument('--rollback',action='store_true')
    args=parser.parse_args()
    if args.rollback:
        need(os.geteuid()==0,'ROOT_REQUIRED')
        record=json.loads((STATE/'receipt.json').read_text())
        need(record.get('revision')=='v09-r2-nginx-quote-01','WRONG_RECEIPT')
        rollback(record); print(json.dumps({'status':'NEW_PROXY_STOPPED_ORIGINAL_CONFIG_RESTORED'})); return
    data=precheck()
    if not args.apply:
        print(json.dumps({'status':'READ_ONLY_PREFLIGHT_PASS','verifiedCompleteRuntimeFiles':data[1],'writes':False})); return
    print(json.dumps(apply(*data)))


if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'status':'STOPPED','phase':phase,'errorCode':str(error) if isinstance(error,RuntimeError) else type(error).__name__})); raise SystemExit(1)
