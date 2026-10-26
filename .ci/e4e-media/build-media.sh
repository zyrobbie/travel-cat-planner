#!/usr/bin/env bash
# Invoke in an isolated network namespace, as the runner user, never on the server.
set -euo pipefail
umask 077
test "${GITHUB_ACTIONS:-}" = true
test "${E4E_MEDIA_OFFLINE_NAMESPACE:-}" = 1
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$(. /etc/os-release; printf '%s' "$VERSION_ID")" = 24.04
if [ "$#" -ne 3 ]; then
  printf 'Usage: build-media.sh WORK_DIR NEW_ARTIFACT_DIR V09_R2_INPUT_DIR\n' >&2
  exit 2
fi
task_scripts="$(cd "$(dirname "$0")" && pwd)"
task_work="$1"
task_output="$2"
task_input="$3"
test ! -e "$task_output"
mkdir -m 700 "$task_output"
mkdir -m 700 "$task_work/build" "$task_output/bin" "$task_output/evidence" "$task_output/source"
task_options=(
  --prefix=/opt/cat-letters-media/ffmpeg-6.1.6
  --disable-everything --disable-autodetect --disable-network
  --disable-doc --disable-debug --disable-ffplay --disable-shared --enable-static
  --disable-avdevice --disable-swscale --disable-postproc
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample
  --enable-ffmpeg --enable-ffprobe --enable-runtime-cpudetect
  --enable-protocol=file,pipe
  --enable-demuxer=matroska,ogg,mov,wav
  --enable-parser=opus,aac
  --enable-decoder=opus,aac,pcm_s16le,pcm_s24le,pcm_f32le
  --enable-encoder=pcm_s16le
  --enable-muxer=pcm_s16le
  --enable-filter=aformat,anull,atrim,aresample
  --extra-ldflags=-static-libgcc
)
printf '%s\n' "${task_options[@]}" > "$task_output/evidence/configure-options.txt"
(
  cd "$task_work/build"
  "$task_work/source/ffmpeg-6.1.6/configure" "${task_options[@]}" > "$task_output/evidence/configure.log" 2>&1
  /usr/bin/time -v -o "$task_output/evidence/build-resources.txt" \
    make -j2 ffmpeg ffprobe > "$task_output/evidence/build.log" 2>&1
)
install -m 755 "$task_work/build/ffmpeg" "$task_output/bin/ffmpeg"
install -m 755 "$task_work/build/ffprobe" "$task_output/bin/ffprobe"
cp "$task_work/build/config_components.h" "$task_output/evidence/"
cp "$task_work/source/ffmpeg-6.1.6/COPYING.LGPLv2.1" "$task_work/source/ffmpeg-6.1.6/LICENSE.md" "$task_output/source/"
cp "$task_work/downloads/ffmpeg-6.1.6.tar.xz" "$task_work/downloads/ffmpeg-6.1.6.tar.xz.asc" "$task_work/downloads/ffmpeg-devel.asc" "$task_output/source/"
cp "$task_work/source-provenance.json" "$task_work/signature-status.txt" "$task_output/evidence/"
cp "$task_scripts/source-lock.json" "$task_output/evidence/"
cp "$task_input/BUILD-INPUT.json" "$task_output/evidence/candidate-BUILD-INPUT.json"
printf 'Unmodified official source. No patches. FFmpeg libraries linked statically; host libc/libm remain dynamic.\n' > "$task_output/source/SOURCE-CHANGES.txt"
python3 "$task_scripts/media-tools.py" inspect "$task_output" "$task_scripts/source-lock.json"
python3 "$task_scripts/make-fixtures.py" "$task_work/fixtures"
cp "$task_work/fixtures/manifest.json" "$task_output/evidence/synthetic-fixtures.json"
(
  cd "$task_work/candidate"
  /usr/bin/time -v -o "$task_output/evidence/compat-harness-resources.txt" \
    node --import tsx "$task_scripts/media-compat.mts" \
      "$task_work/candidate" "$task_output/bin" "$task_work/fixtures" "$task_output/evidence/compatibility.json"
)
python3 "$task_scripts/media-tools.py" resource-check "$task_output" "$task_work/fixtures" "$task_scripts/source-lock.json"
python3 "$task_scripts/media-tools.py" check-tree "$task_work/candidate" "$task_input"
mkdir "$task_output/build-recipe"
cp "$task_scripts/"*.py "$task_scripts/"*.sh "$task_scripts/"*.mts "$task_scripts/"*.json "$task_scripts/README.md" "$task_output/build-recipe/"
python3 "$task_scripts/media-tools.py" finish "$task_output"
