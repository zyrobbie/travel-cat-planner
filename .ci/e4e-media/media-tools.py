#!/usr/bin/env python3
"""Public-source build helpers. No credentials, remote shell or application services."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import shutil
import subprocess
import sys
import tarfile
import urllib.parse
import urllib.request


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, document):
    Path(path).write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n')


def run(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, stderr=subprocess.STDOUT, **kwargs)


def signature_is_valid(status, fingerprint):
    records = [line.split() for line in status.splitlines() if line.startswith('[GNUPG:] ')]
    if any(len(r) > 1 and r[1] in {'BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'KEYEXPIRED', 'SIGEXPIRED'} for r in records):
        return False
    valid = [r for r in records if len(r) > 2 and r[1] == 'VALIDSIG']
    return len(valid) == 1 and (valid[0][2] == fingerprint or valid[0][-1] == fingerprint)


def fetch(work, lock_path):
    work, lock_path = Path(work), Path(lock_path)
    lock = json.loads(lock_path.read_text())
    downloads = work / 'downloads'
    downloads.mkdir(mode=0o700)
    version = lock['ffmpegVersion']
    names = [('sourceUrl', f'ffmpeg-{version}.tar.xz', 64 * 1024**2),
             ('signatureUrl', f'ffmpeg-{version}.tar.xz.asc', 64 * 1024),
             ('signingKeyUrl', 'ffmpeg-devel.asc', 1024 * 1024)]
    for key, name, limit in names:
        url = lock[key]
        require(urllib.parse.urlparse(url).scheme == 'https' and urllib.parse.urlparse(url).hostname == 'ffmpeg.org', 'NONOFFICIAL_SOURCE')
        with urllib.request.urlopen(url, timeout=45) as response:
            parsed = urllib.parse.urlparse(response.url)
            require(parsed.scheme == 'https' and parsed.hostname == 'ffmpeg.org', 'SOURCE_REDIRECT_REJECTED')
            with (downloads / name).open('xb') as output:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= limit, 'SOURCE_DOWNLOAD_TOO_LARGE')
                    output.write(chunk)
    gpg_home = work / 'gpg'
    gpg_home.mkdir(mode=0o700)
    gpg = ['gpg', '--no-options', '--homedir', str(gpg_home), '--batch', '--no-auto-key-retrieve']
    key = downloads / 'ffmpeg-devel.asc'
    shown = run([*gpg, '--with-colons', '--import-options', 'show-only', '--import', key])
    primary = []
    seek = False
    for line in shown.splitlines():
        parts = line.split(':')
        if parts[0] == 'pub':
            seek = True
        elif parts[0] == 'fpr' and seek:
            primary.append(parts[9]); seek = False
    require(primary == [lock['signingPrimaryFingerprint']], 'SIGNING_KEY_MISMATCH')
    run([*gpg, '--import', key])
    checked = subprocess.run([*gpg, '--status-fd', '1', '--verify',
                              str(downloads / f'ffmpeg-{version}.tar.xz.asc'),
                              str(downloads / f'ffmpeg-{version}.tar.xz')],
                             capture_output=True, text=True, timeout=30)
    (work / 'signature-status.txt').write_text(checked.stdout + '\n' + checked.stderr)
    require(checked.returncode == 0 and signature_is_valid(checked.stdout, lock['signingPrimaryFingerprint']), 'SOURCE_SIGNATURE_INVALID')
    # No source code is executed until the signature and pinned identity pass.
    source = work / 'source'
    source.mkdir(mode=0o700)
    prefix = f'ffmpeg-{version}'
    with tarfile.open(downloads / f'{prefix}.tar.xz', 'r:xz') as archive:
        total = 0
        seen = set()
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and path.parts and path.parts[0] == prefix
                    and '..' not in path.parts and '\\' not in member.name
                    and not any(ord(c) < 32 for c in member.name)
                    and (member.isfile() or member.isdir()), 'UNSAFE_SOURCE_MEMBER')
            require(member.name not in seen, 'DUPLICATE_SOURCE_MEMBER')
            seen.add(member.name)
            total += member.size
            require(total <= 512 * 1024**2 and member.size <= 64 * 1024**2, 'SOURCE_UNPACK_TOO_LARGE')
            target = source.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                with target.open('xb') as output, archive.extractfile(member) as input_file:
                    shutil.copyfileobj(input_file, output)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
    save(work / 'source-provenance.json', {
        'schemaVersion': 1, 'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'version': version, 'signingPrimaryFingerprint': lock['signingPrimaryFingerprint'],
        'signatureVerified': True, 'patches': [],
        'downloads': [{'url': lock[k], 'file': name, 'sha256': sha(downloads / name)} for k, name, _ in names],
    })


def check_input(input_dir, lock_path):
    root, lock = Path(input_dir), json.loads(Path(lock_path).read_text())
    document = json.loads((root / 'BUILD-INPUT.json').read_text())
    require(document['candidateVersion'] == lock['candidateVersion'], 'CANDIDATE_VERSION_MISMATCH')
    require(document['engineeringFreezeSha256'] == lock['engineeringFreezeSha256'], 'ENGINEERING_FREEZE_MISMATCH')
    for key, file in [('sourceArchiveSha256', 'source.tar.gz'), ('sourceManifestSha256', 'source-manifest.json')]:
        require(document[key] == lock[key] == sha(root / file), 'V09_R2_INPUT_HASH_MISMATCH')
    require(document['packageLockSha256'] == lock['packageLockSha256'], 'V09_R2_LOCK_MISMATCH')
    manifest = json.loads((root / 'source-manifest.json').read_text())
    require(manifest['version'] == lock['candidateVersion'] and len(manifest['filesSha256']) == lock['candidateSourceFileCount'], 'V09_R2_MANIFEST_MISMATCH')
    require(manifest['filesSha256']['src/server/voice-probe.ts'] == lock['candidateVoiceProbeSha256'], 'VOICE_PROBE_SOURCE_MISMATCH')


def check_tree(candidate, input_dir):
    manifest = json.loads((Path(input_dir) / 'source-manifest.json').read_text())
    for name, digest in manifest['filesSha256'].items():
        path = Path(candidate) / name
        require(path.is_file() and not path.is_symlink() and sha(path) == digest, 'FROZEN_SOURCE_CHANGED: ' + name)


def elf_requirements(dynamic, versions, program, notes, allowlist, maximum):
    needed = re.findall(r'\(NEEDED\).*?\[(.*?)\]', dynamic)
    require(needed and set(needed) <= set(allowlist), 'UNEXPECTED_RUNTIME_LIBRARY: ' + repr(needed))
    require(not re.search(r'\((?:RPATH|RUNPATH)\)', dynamic), 'RPATH_REJECTED')
    require('/lib64/ld-linux-x86-64.so.2' in program, 'UNEXPECTED_ELF_INTERPRETER')
    numeric = sorted({tuple(map(int, v.split('.'))) for v in re.findall(r'GLIBC_([0-9]+\.[0-9]+(?:\.[0-9]+)?)', versions)})
    require(numeric and max(numeric) <= tuple(map(int, maximum.split('.'))), 'GLIBC_TOO_NEW')
    require('GLIBC_PRIVATE' not in versions, 'PRIVATE_GLIBC_ABI_REJECTED')
    require(not re.search(r'x86 ISA needed:.*x86-64-v[234]', notes), 'NONBASELINE_CPU_REQUIREMENT')
    return {'needed': needed, 'maximumGlibcSymbol': '.'.join(map(str, max(numeric))),
            'interpreter': '/lib64/ld-linux-x86-64.so.2', 'rpath': None}


def inspect(output, lock_path):
    output, lock = Path(output), json.loads(Path(lock_path).read_text())
    evidence = output / 'evidence'
    configuration = (evidence / 'config_components.h').read_text()
    enabled = set(re.findall(r'^#define CONFIG_(\w+) 1$', configuration, re.M))
    expected = {
        'DECODER': {'OPUS', 'AAC', 'PCM_S16LE', 'PCM_S24LE', 'PCM_F32LE'},
        'ENCODER': {'PCM_S16LE'}, 'MUXER': {'PCM_S16LE'},
        'DEMUXER': {'MATROSKA', 'OGG', 'MOV', 'WAV'}, 'PROTOCOL': {'FILE', 'PIPE'},
    }
    for kind, names in expected.items():
        actual = {value[:-(len(kind) + 1)] for value in enabled if value.endswith('_' + kind)}
        require(actual == names, 'UNEXPECTED_ENABLED_' + kind + ': ' + repr(sorted(actual)))
    records = []
    for name in ['ffmpeg', 'ffprobe']:
        binary = output / 'bin' / name
        details = {flag: run(['readelf', flag, binary]) for flag in ['-dW', '-VW', '-lW', '-nW']}
        for flag, text in details.items():
            (evidence / f'{name}-elf{flag}.txt').write_text(text)
        limits = elf_requirements(details['-dW'], details['-VW'], details['-lW'], details['-nW'], lock['runtimeNeededAllowlist'], lock['maxGlibcVersion'])
        version = run([binary, '-version'])
        require(version.startswith(name + ' version ' + lock['ffmpegVersion']), 'UNEXPECTED_FFMPEG_VERSION')
        require('--enable-gpl' not in version and '--enable-nonfree' not in version and '--enable-version3' not in version, 'LICENSE_CONFIGURATION_REJECTED')
        (evidence / f'{name}-version.txt').write_text(version)
        records.append({'file': f'bin/{name}', 'bytes': binary.stat().st_size, 'sha256': sha(binary), **limits})
    protocols = run([output / 'bin/ffmpeg', '-hide_banner', '-protocols'])
    named = set(re.findall(r'^\s{2,}(\w+)\s*$', protocols, re.M))
    require(named == {'file', 'pipe'}, 'UNEXPECTED_PROTOCOLS: ' + repr(named))
    (evidence / 'protocols.txt').write_text(protocols)
    for flag in ['-decoders', '-encoders', '-demuxers', '-muxers', '-filters', '-buildconf']:
        (evidence / f'ffmpeg{flag}.txt').write_text(run([output / 'bin/ffmpeg', '-hide_banner', flag]))
    require(sum(x['bytes'] for x in records) <= 64 * 1024**2, 'MEDIA_BINARIES_TOO_LARGE')
    save(evidence / 'runtime-dependencies.json', {'status': 'PASS_LIMITED', 'binaries': records,
        'protocols': sorted(named), 'notTested': ['target host loader execution', 'target host package versions']})
    packages = run(['dpkg-query', '-W', '-f=${Package} ${Version}\n', 'libc6', 'gcc', 'make', 'nasm', 'ffmpeg', 'gnupg', 'binutils'])
    (evidence / 'build-environment.txt').write_text(run(['uname', '-a']) + Path('/etc/os-release').read_text() + '\n' + packages + '\n' + run(['gcc', '--version']))


def resource_check(output, fixtures, lock_path):
    output, fixtures = Path(output), Path(fixtures)
    lock = json.loads(Path(lock_path).read_text())
    # Frozen v09-r2 command shape for resource measurement only. AAC end_sample
    # below is bound to this known synthetic fixture, not a substitute for proof.
    # Actual compatibility above imports the frozen functions instead of this list.
    probe = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_alloc', '16777216',
             '-show_entries', 'stream=index,codec_type,codec_name,sample_rate,time_base,start_pts,duration_ts:packet=stream_index,pts,duration,pts_time,duration_time:packet_side_data=side_data_type,skip_samples', '-of', 'json']
    frames = ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_alloc', '16777216',
              '-show_entries', 'frame=pts,nb_samples', '-of', 'json']
    decode_before = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_alloc', '16777216',
                     '-probesize', '1048576', '-analyzeduration', '5000000', '-threads', '1', '-filter_threads', '1', '-i']
    decode_map = ['-map', '0:a:0', '-vn', '-sn', '-dn']
    decode_output = ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']
    records = []
    fixture_metadata = {item['file']: item for item in json.loads((fixtures / 'manifest.json').read_text())['records']}
    for filename in ['webm-opus-60s.webm', 'mp4-aac-60s.m4a']:
        aac = filename == 'mp4-aac-60s.m4a'
        fixture = fixture_metadata[filename]
        require(fixture['sourceSeconds'] == 60 and sha(fixtures / filename) == fixture['sha256'], 'RESOURCE_FIXTURE_MISMATCH')
        if aac:
            require(fixture['sourceRate'] == 48000, 'AAC_RESOURCE_FIXTURE_RATE_MISMATCH')
        trim = ['-af', 'atrim=end_sample=2880000'] if aac else []
        steps = [('ffprobe', 'packets', [*probe, str(fixtures / filename)], 5)]
        if aac:
            steps.append(('ffprobe', 'frames', [*frames, str(fixtures / filename)], 5))
        steps.append(('ffmpeg', 'decode', [*decode_before, str(fixtures / filename), *decode_map, *trim, *decode_output], 10))
        for name, phase, arguments, timeout in steps:
            report = output / 'evidence' / f'{name}-{phase}-{filename}-resources.txt'
            process = subprocess.Popen(['/usr/bin/time', '-v', '-o', str(report), str(output / 'bin' / name), *arguments],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                       env={'LANG': 'C', 'PATH': '/usr/bin:/bin', 'NODE_ENV': 'production', 'TMPDIR': str(fixtures)},
                                       start_new_session=True)
            try:
                process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise ValueError(f'RESOURCE_PROBE_TIMEOUT: {name}/{filename}')
            require(process.returncode == 0, f'RESOURCE_PROBE_FAILED: {name}/{filename}')
            text = report.read_text()
            match = re.search(r'Maximum resident set size \(kbytes\): (\d+)', text)
            require(match is not None, 'MISSING_RESOURCE_MEASUREMENT')
            rss = int(match.group(1))
            require(rss <= lock['mediaProcessMaxRssKiB'], 'MEDIA_RSS_BUDGET_EXCEEDED')
            records.append({'binary': name, 'phase': phase, 'fixture': filename, 'peakRssKiB': rss, 'wallTimeoutSeconds': timeout, 'completedWithinTimeout': True})
    save(output / 'evidence/resource-check.json', {'status': 'PASS_LIMITED', 'perProcessBudgetKiB': lock['mediaProcessMaxRssKiB'], 'records': records,
        'scope': 'isolated runner, synthetic 60-second inputs; v09-r2 AAC frame probe and known-fixture end_sample trim; individual-process timeouts only, shared probe deadline remains in actual product compatibility path; max_alloc is per allocation, not a total-memory cap',
        'notTested': ['2GB target server capacity', 'whole app/cgroup peak', 'adversarial media', 'multi-user production load']})


def finish(output):
    output = Path(output)
    evidence = output / 'evidence'
    for file in ['compatibility.json', 'runtime-dependencies.json', 'resource-check.json']:
        require(json.loads((evidence / file).read_text())['status'] == 'PASS_LIMITED', 'REQUIRED_MEDIA_CHECK_FAILED')
    save(evidence / 'result.json', {'status': 'PASS_LIMITED_CI', 'completedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'signed-source build, dependency checks, frozen v09-r2 actual media functions with synthetic inputs, bounded runner resources',
        'notTested': ['server install/execution', 'real browser/iPhone recordings', 'real ASR', 'tmpfs service isolation', 'whole application', 'user acceptance'],
        'deploymentAuthorizedByThisArtifact': False})
    files = {}
    for path in sorted(output.rglob('*')):
        require(not path.is_symlink(), 'ARTIFACT_SYMLINK_REJECTED')
        if path.is_file():
            files[str(path.relative_to(output))] = sha(path)
    save(output / 'SHA256-MANIFEST.json', {'schemaVersion': 1, 'files': files})


if __name__ == '__main__':
    actions = {'fetch': fetch, 'check-input': check_input, 'check-tree': check_tree,
               'inspect': inspect, 'resource-check': resource_check, 'finish': finish}
    actions[sys.argv[1]](*sys.argv[2:])
