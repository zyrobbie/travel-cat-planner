#!/usr/bin/env python3
"""Frozen-source staging and Linux package checks; no deployment/credentials."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def safe_name(value):
    path = PurePosixPath(value)
    require(isinstance(value, str) and value and not path.is_absolute()
            and '..' not in path.parts and str(path) == value
            and not any(ord(c) < 32 for c in value), 'UNSAFE_PATH')
    # Backslash is a valid literal in Linux systemd escaped-unit filenames.
    return value


def frozen_files(archive, manifest):
    expected = manifest['filesSha256']
    require(isinstance(expected, dict) and 1 <= len(expected) <= 2500,
            'INVALID_SOURCE_MANIFEST')
    files, total = {}, 0
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            require(member.isfile() and member.name.startswith('cat-letters/'),
                    'SOURCE_NOT_REGULAR_FILE')
            name = safe_name(member.name[len('cat-letters/'):])
            parts = PurePosixPath(name).parts
            require(name not in files and name in expected, 'SOURCE_MEMBER_MISMATCH')
            require(not any(p in {'.git', '.local', '.next', 'node_modules'} for p in parts)
                    and not any(p.startswith('.env') and p != '.env.example' for p in parts)
                    and not name.lower().endswith(('.csv', '.pem', '.key', '.p12', '.pfx')),
                    'PRIVATE_OR_PLATFORM_SOURCE_REJECTED')
            total += member.size
            require(member.size <= 64 * 1024**2 and total <= 512 * 1024**2,
                    'SOURCE_TOO_LARGE')
            content = tar.extractfile(member).read()
            require(hashlib.sha256(content).hexdigest() == expected[name], 'SOURCE_HASH_MISMATCH')
            files[name] = (content, member.mode & 0o755)
    require(set(files) == set(expected), 'SOURCE_FILES_MISSING')
    require({'package.json', 'package-lock.json', 'next.config.ts', 'scripts/voice-cleanup.ts'} <= set(files),
            'SOURCE_REQUIRED_FILES_MISSING')
    lock = json.loads(files['package-lock.json'][0])
    require(lock.get('lockfileVersion') == 3, 'UNEXPECTED_LOCKFILE_FORMAT')
    for package in lock.get('packages', {}).values():
        resolved = package.get('resolved')
        if resolved:
            url = urllib.parse.urlparse(resolved)
            require(url.scheme == 'https' and url.hostname == 'registry.npmjs.org'
                    and not url.username and not url.password, 'NONPUBLIC_NPM_DEPENDENCY')
    return files


def stage(archive, freeze, destination, expected_sha):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha), 'INVALID_EXPECTED_SHA')
    require(not destination.exists(), 'DESTINATION_EXISTS')
    document = json.loads(freeze.read_text())
    require(sha(archive) == expected_sha
            and document['artifacts'].get(archive.name) == expected_sha, 'ARCHIVE_HASH_MISMATCH')
    frozen_files(archive, document)
    # Do not publish local workspace paths or the entire engineering receipt.
    manifest = {'version': document['version'], 'filesSha256': document['filesSha256']}
    destination.mkdir(mode=0o700, parents=False)
    shutil.copyfile(archive, destination / 'source.tar.gz')
    (destination / 'source-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    record = {'schemaVersion': 1, 'candidateVersion': document['version'],
              'sourceArchiveSha256': expected_sha, 'engineeringFreezeSha256': sha(freeze),
              'sourceManifestSha256': sha(destination / 'source-manifest.json'),
              'packageLockSha256': document['filesSha256']['package-lock.json']}
    (destination / 'BUILD-INPUT.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'staged': True, **record}))


def extract(input_dir, destination):
    require(not destination.exists(), 'DESTINATION_EXISTS')
    require(set(p.name for p in input_dir.iterdir()) ==
            {'source.tar.gz', 'source-manifest.json', 'BUILD-INPUT.json'}, 'UNEXPECTED_INPUT_FILE')
    record = json.loads((input_dir / 'BUILD-INPUT.json').read_text())
    require(record.get('schemaVersion') == 1, 'INVALID_INPUT_SCHEMA')
    for name, key in [('source.tar.gz', 'sourceArchiveSha256'),
                      ('source-manifest.json', 'sourceManifestSha256')]:
        require(sha(input_dir / name) == record[key], 'INPUT_HASH_MISMATCH')
    manifest = json.loads((input_dir / 'source-manifest.json').read_text())
    files = frozen_files(input_dir / 'source.tar.gz', manifest)
    require(record['packageLockSha256'] == manifest['filesSha256']['package-lock.json'],
            'LOCKFILE_HASH_MISMATCH')
    destination.mkdir(mode=0o700, parents=False)
    for name, (content, mode) in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(mode)
    shutil.copyfile(input_dir / 'BUILD-INPUT.json', destination / 'BUILD-INPUT.json')
    shutil.copyfile(input_dir / 'source-manifest.json', destination / 'SOURCE-MANIFEST.json')
    print(json.dumps({'frozenFilesVerified': len(files), 'sourceSha256': record['sourceArchiveSha256']}))


def clean_environment():
    # No inherited cloud/API/GitHub credential environment, even if future
    # workflow configuration changes. These placeholders never leave loopback.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG') if k in os.environ}
    env.update({'CI': 'true', 'NEXT_TELEMETRY_DISABLED': '1', 'DOTENV_CONFIG_PATH': '/dev/null',
                'APP_MODE': 'INTERNAL', 'APP_ORIGIN': 'http://127.0.0.1:3199',
                'COOKIE_SECURE': 'false', 'OTP_ADAPTER': 'synthetic-v1',
                'DATABASE_URL': 'postgresql://build:synthetic@127.0.0.1:1/build',
                'E4_LEDGER_DATABASE_URL': 'postgresql://build:synthetic@127.0.0.1:2/ledger',
                'E4_LIFECYCLE_ADAPTER': 'postgres-v1',
                'E4_LEDGER_SECRET': 'BuildOnlyNotARealSecret00000000000000',
                'OTP_HASH_SECRET': 'BuildOnlyNotARealSecret00000000000000',
                'E4_VOICE_ENABLED': 'false', 'E4_VOICE_MODE': 'disabled',
                'E4_VOICE_CLEANUP_ENABLED': 'false', 'E4_VOICE_ACCOUNT_IDS': '[]',
                'E4_MANUAL_WORKER_ENABLED': 'false', 'E4_SCHEDULED_EXPORTS_ENABLED': 'false',
                'E4_AUTO_DELIVERY_ENABLED': 'false', 'E4_LIFECYCLE_BOOTSTRAP': 'false',
                'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1'})
    return env


def build(source, output):
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'LINUX_X64_REQUIRED')
    distro = platform.freedesktop_os_release()
    require(distro.get('ID') == 'ubuntu' and distro.get('VERSION_ID') == '24.04', 'UBUNTU_2404_REQUIRED')
    require(subprocess.check_output(['node', '--version'], text=True).strip() == 'v22.23.3', 'NODE_VERSION_MISMATCH')
    # sysfs can still reflect its original namespace; query the current
    # network namespace through netlink instead.
    interfaces = json.loads(subprocess.check_output(['ip', '-j', 'link'], text=True))
    require({item['ifname'] for item in interfaces} == {'lo'}, 'EXTERNAL_NETWORK_NAMESPACE_PRESENT')
    record = json.loads((source / 'BUILD-INPUT.json').read_text())
    require(sha(source / 'package-lock.json') == record['packageLockSha256'], 'LOCKFILE_CHANGED')
    source_manifest = json.loads((source / 'SOURCE-MANIFEST.json').read_text())
    require(all(sha(source / p) == value for p, value in source_manifest['filesSha256'].items()),
            'FROZEN_SOURCE_CHANGED_DURING_INSTALL')
    env = clean_environment()
    for label, command in [('build', ['npm', 'run', 'build']), ('typecheck', ['npm', 'run', 'typecheck'])]:
        with (output / (label + '.log')).open('wb') as log:
            result = subprocess.run(command, cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        require(result.returncode == 0, label.upper() + '_FAILED_SEE_LOG')
    require(sha(source / 'package-lock.json') == record['packageLockSha256'], 'LOCKFILE_CHANGED')
    require((source / '.next/BUILD_ID').is_file() and
            (source / 'public/account-app/index.html').is_file(), 'BUILD_OUTPUT_MISSING')
    # Confirm that the deployed cleanup CLI still loads tsx and all imports;
    # keep its execution gate closed and never start a worker/migration.
    check = subprocess.run(['node', '--import', 'tsx', 'scripts/voice-cleanup.ts'], cwd=source,
                           env=env, capture_output=True, text=True, timeout=20)
    require(check.returncode == 1 and check.stdout.strip() == ''
            and check.stderr.strip() == 'VOICE_CLEANUP_FAILED', 'CLEANUP_DISABLED_IMPORT_CHECK_FAILED')
    with (output / 'anonymous-smoke.log').open('wb') as log:
        proc = subprocess.Popen(['node', 'node_modules/next/dist/bin/next', 'start',
                                 '--hostname', '127.0.0.1', '--port', '3199'],
                                cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT)
        ok = False
        try:
            for _ in range(30):
                if proc.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen('http://127.0.0.1:3199/account-app/', timeout=2) as response:
                        body = response.read(2 * 1024 * 1024)
                        ok = response.status == 200 and b'<html' in body.lower()
                    if ok:
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(1)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        require(ok, 'ANONYMOUS_PAGE_SMOKE_FAILED')
    package(source, output, record, distro)


def package(source, output, input_record, distro):
    # This Next config is not standalone. Preserve the complete Linux-installed
    # dependency tree (including tsx), source/scripts/db/deploy, and build output.
    manifest = json.loads((source / 'SOURCE-MANIFEST.json').read_text())['filesSha256']
    names = set(manifest)
    for top in ('node_modules', '.next', 'public'):
        for directory, dirs, files in os.walk(source / top, followlinks=False):
            relative = Path(directory).relative_to(source)
            dirs[:] = sorted(d for d in dirs if str(relative / d) not in {'.next/cache', '.next/dev'})
            for name in dirs[:]:
                path = source / relative / name
                if path.is_symlink():
                    names.add(str(relative / name))
                    dirs.remove(name)
            names.update(str(relative / name) for name in files)
    files, links = {}, {}
    for name in sorted(names):
        safe_name(name)
        path = source / name
        if path.is_symlink():
            target = os.readlink(path)
            require(not os.path.isabs(target) and path.resolve().is_relative_to(source.resolve()),
                    'RUNTIME_LINK_ESCAPE')
            links[name] = target
        else:
            require(path.is_file(), 'RUNTIME_SPECIAL_FILE')
            require(not any(p.startswith('.env') and p != '.env.example' for p in PurePosixPath(name).parts),
                    'RUNTIME_ENV_REJECTED')
            files[name] = sha(path)
    archive = output / 'cat-voice-linux-amd64.tar.gz'
    with tarfile.open(archive, 'w:gz', dereference=False) as tar:
        for name in sorted(names):
            info = tar.gettarinfo(str(source / name), arcname='cat-voice-runtime/' + name)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode &= 0o777
            if name in files:
                # gettarinfo(dereference=False) deduplicates hard-linked regular
                # files as LNKTYPE. The manifest/installer contract instead
                # requires a complete regular-file entry at every such path.
                # Keep real symlinks intact; never set global dereference=True.
                require(info.isfile() or info.islnk(), 'RUNTIME_SOURCE_TYPE_CHANGED: ' + name)
                fd = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as data:
                    current = os.fstat(data.fileno())
                    require(stat.S_ISREG(current.st_mode), 'RUNTIME_SOURCE_TYPE_CHANGED: ' + name)
                    info.type = tarfile.REGTYPE
                    info.linkname = ''
                    info.size = current.st_size
                    tar.addfile(info, data)
            else:
                require(info.issym() and info.linkname == links[name], 'RUNTIME_SOURCE_LINK_CHANGED: ' + name)
                tar.addfile(info)
    require(archive.stat().st_size <= 600 * 1024**2, 'RUNTIME_ARCHIVE_TOO_LARGE')
    (output / 'RUNTIME-MANIFEST.json').write_text(json.dumps({'filesSha256': files, 'symlinks': links}, sort_keys=True) + '\n')
    metadata = {'schemaVersion': 1, 'status': 'LINUX_BUILD_AND_ANONYMOUS_SMOKE_PASS',
                **input_record, 'commit': os.environ.get('E4E_BUILD_COMMIT'),
                'platform': 'linux/x64', 'os': distro.get('PRETTY_NAME'), 'node': 'v22.23.3',
                'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
                'runtimeArchiveSha256': sha(archive),
                'runtimeManifestSha256': sha(output / 'RUNTIME-MANIFEST.json'),
                'runtimeFiles': len(files), 'runtimeSymlinks': len(links),
                'nextStandalone': False, 'tsxRetained': (source / 'node_modules/tsx').is_dir(),
                'externalNetworkDuringBuild': False, 'realCredentialsUsed': False,
                'realAsrCalled': False, 'databaseAccessed': False, 'serverDeployed': False,
                'remainingValidation': ['actual Linux target storage/resource checks', 'real credentials/provider', 'real device']}
    (output / 'BUILD.json').write_text(json.dumps(metadata, indent=2) + '\n')
    shutil.copyfile(source / 'BUILD-INPUT.json', output / 'BUILD-INPUT.json')
    print(json.dumps(metadata))


def verify(directory):
    record = json.loads((directory / 'BUILD.json').read_text())
    archive = directory / 'cat-voice-linux-amd64.tar.gz'
    require(sha(archive) == record['runtimeArchiveSha256'] and
            sha(directory / 'RUNTIME-MANIFEST.json') == record['runtimeManifestSha256'], 'BUNDLE_HASH_MISMATCH')
    require(record['platform'] == 'linux/x64' and record['node'] == 'v22.23.3', 'WRONG_TARGET')
    manifest = json.loads((directory / 'RUNTIME-MANIFEST.json').read_text())
    expected = set(manifest['filesSha256']) | set(manifest['symlinks'])
    require(not set(manifest['filesSha256']) & set(manifest['symlinks']), 'DUPLICATE_MANIFEST_MEMBER')
    seen = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            require(member.name.startswith('cat-voice-runtime/'), 'WRONG_ARCHIVE_ROOT')
            name = safe_name(member.name[len('cat-voice-runtime/'):])
            require(name in expected and name not in seen, 'UNEXPECTED_RUNTIME_MEMBER')
            seen.add(name)
            if name in manifest['symlinks']:
                require(member.issym() and member.linkname == manifest['symlinks'][name], 'RUNTIME_LINK_MISMATCH')
                # Reject absolute targets, escape and files nested underneath a symlink.
                normalized = os.path.normpath(str(PurePosixPath(name).parent / member.linkname))
                require(not member.linkname.startswith('/') and not normalized.startswith('../'), 'RUNTIME_LINK_ESCAPE')
            else:
                require(member.isfile(), 'RUNTIME_FILE_TYPE_MISMATCH: ' + name)
                require(hashlib.sha256(tar.extractfile(member).read()).hexdigest()
                        == manifest['filesSha256'][name], 'RUNTIME_FILE_HASH_MISMATCH: ' + name)
            require(not any(str(parent) in manifest['symlinks'] for parent in PurePosixPath(name).parents),
                    'RUNTIME_PARENT_IS_LINK')
    require(seen == expected, 'RUNTIME_MEMBER_MISSING')
    print(json.dumps({'verified': True, 'sourceArchiveSha256': record['sourceArchiveSha256'],
                      'commit': record['commit'], 'files': len(seen), 'serverDeployed': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('stage')
    for arg in ('archive', 'freeze', 'destination'):
        p.add_argument(arg, type=Path)
    p.add_argument('--expected-source-sha', required=True)
    p = sub.add_parser('extract')
    p.add_argument('input_dir', type=Path)
    p.add_argument('destination', type=Path)
    p = sub.add_parser('build')
    p.add_argument('source', type=Path)
    p.add_argument('output', type=Path)
    p = sub.add_parser('verify')
    p.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'stage':
            stage(args.archive.resolve(), args.freeze.resolve(), args.destination.resolve(), args.expected_source_sha)
        elif args.command == 'extract':
            extract(args.input_dir.resolve(), args.destination.resolve())
        elif args.command == 'build':
            build(args.source.resolve(), args.output.resolve())
        else:
            verify(args.directory.resolve())
    except Exception as error:
        raise SystemExit('E4E_LINUX_BUILD_REJECTED: ' + str(error))
