#!/usr/bin/env python3
"""Generate non-speech tones with the runner's Ubuntu ffmpeg. Never read user audio."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(sys.argv[1]).resolve()
    root.mkdir(mode=0o700, exist_ok=False)
    reference = Path('/usr/bin/ffmpeg')
    records = []

    def generate(name, mime, codec, seconds=1, rate=44100, channels=2,
                 fmt=None, extra=(), expected='accept', pipe=False):
        output = root / name
        args = [str(reference), '-nostdin', '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', f'sine=frequency=440:sample_rate={rate}:duration={seconds}',
                '-map', '0:a:0', '-ac', str(channels), '-c:a', codec, *extra]
        if fmt:
            args += ['-f', fmt]
        args += ['pipe:1' if pipe else str(output)]
        result = subprocess.run(args, check=True, capture_output=True, timeout=30)
        if pipe:
            output.write_bytes(result.stdout)
        data = output.read_bytes()
        records.append({'file': name, 'mime': mime, 'sourceSeconds': seconds,
                        'sourceRate': rate, 'sourceChannels': channels,
                        'expected': expected, 'bytes': len(data),
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'generationArguments': args[1:-1] + ['<synthetic-output>']})

    for suffix, codec in [('s16', 'pcm_s16le'), ('s24', 'pcm_s24le'), ('float', 'pcm_f32le')]:
        generate(f'wav-{suffix}-1s.wav', 'audio/wav', codec, fmt='wav')
    generate('ogg-opus-1s.ogg', 'audio/ogg', 'libopus', rate=48000, fmt='ogg')
    generate('webm-opus-1s.webm', 'audio/webm', 'libopus', rate=48000, fmt='webm')
    generate('webm-stream-opus-1s.webm', 'audio/webm', 'libopus', rate=48000, fmt='webm', pipe=True)
    generate('mp4-aac-1s.m4a', 'audio/mp4', 'aac', fmt='mp4')
    generate('mp4-fragment-aac-1s.m4a', 'audio/mp4', 'aac', fmt='mp4',
             extra=('-movflags', 'empty_moov+frag_keyframe+default_base_moof'), pipe=True)
    for seconds, expected in [(60, 'accept'), (61, 'reject')]:
        generate(f'wav-s16-{seconds}s.wav', 'audio/wav', 'pcm_s16le', seconds, 16000, 1, 'wav', expected=expected)
        generate(f'ogg-opus-{seconds}s.ogg', 'audio/ogg', 'libopus', seconds, 48000, 1, 'ogg', expected=expected)
        generate(f'webm-opus-{seconds}s.webm', 'audio/webm', 'libopus', seconds, 48000, 1, 'webm', expected=expected)
        generate(f'mp4-aac-{seconds}s.m4a', 'audio/mp4', 'aac', seconds, 48000, 1, 'mp4', expected=expected)
    generate('ogg-flac-1s.ogg', 'audio/ogg', 'flac', fmt='ogg', expected='reject')
    generate('mp4-two-audio.m4a', 'audio/mp4', 'aac', fmt='mp4',
             extra=('-map', '0:a:0'), expected='reject')
    video = root / 'mp4-video-and-audio.mp4'
    video_args = [str(reference), '-nostdin', '-hide_banner', '-loglevel', 'error',
                  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
                  '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=5:d=1',
                  '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'aac', '-c:v', 'mpeg4',
                  '-threads', '1', str(video)]
    subprocess.run(video_args, check=True, capture_output=True, timeout=30)
    records.append({'file': video.name, 'mime': 'audio/mp4', 'expected': 'reject',
                    'bytes': video.stat().st_size, 'sha256': hashlib.sha256(video.read_bytes()).hexdigest(),
                    'generationArguments': video_args[1:-1] + ['<synthetic-output>']})
    manifest = {'schemaVersion': 1, 'syntheticOnly': True, 'containsHumanVoice': False,
                'referenceVersion': subprocess.check_output([str(reference), '-version'], text=True),
                'records': records}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
