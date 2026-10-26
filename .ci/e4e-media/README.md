# E4-E v09-r2 媒体组件构建准备（2026-10-26）

当前状态：**准备脚本；尚未构建 Linux 媒体候选，也未证明媒体功能通过。** 父任务审核并发布独立 workflow 后，才会运行下列实验。冻结 v09-r2 的 391 个源文件不改动。

本目录独立于保留的 v08 准备目录与失败证据。适配只绑定 v09-r2 冻结输入、实际 voice-probe 摘要及相应资源测量参数；原 26 项真实函数兼容判定保持。`source-lock.json` 同时锁定工程冻结清单摘要，CI 的 BUILD-INPUT 必须与之匹配。旧 v08 的 24/26 FAIL 不改写为通过，也不沿用作 v09-r2 的运行结果。

选择 FFmpeg **6.1.6 官方签名源码**，在一次性 Ubuntu 24.04 amd64 GitHub runner 编译。FFmpeg 自身的库静态链接进 ffmpeg / ffprobe；基础 libc / libm 仍动态链接。这样无需向观察服务器安装 Ubuntu ffmpeg 的桌面、图形和其他编解码依赖，也无需维护一套私有 glibc。它是待验证的候选路线，不是已经验证的部署方案。

## 为什么改用这条路线

| 路线 | 本项目取舍 |
| --- | --- |
| 服务器 apt install ffmpeg | 已有模拟显示会升级观察机现有 libdrm、libX11、libssh 等库；本轮不采用。 |
| Ubuntu 签名包完整私有运行库，包括 glibc/loader | 来源可核验，但私有 loader、依赖闭包和路径维护较复杂；保留历史规划 `../ffmpeg-isolation-plan-20261026.md`，当前不执行。 |
| 官方签名源码、最小功能、宿主基础 libc/libm | 当前准备方案。原参数与 ELF、资源检查都需 CI 实验通过，随后另做目标服务器验证。 |

版本固定为 6.1.6，不下载 latest、快照或第三方静态二进制。选择与现有 Ubuntu 6.1 系列相近的修订版便于缩小兼容变化；这不代表做过该版本的完整漏洞审计。更新版本需重跑本包的限定检查。[官方下载及签名说明](https://ffmpeg.org/download.html)、[固定版本源码配置](https://github.com/FFmpeg/FFmpeg/blob/n6.1.6/configure)。

## 信任与可复现边界

- `source-lock.json` 固定版本、官方 HTTPS 地址、主签名指纹 `FCF986EA15E6E293A5644F10B4322F04D67658D8`、v09-r2 输入摘要。
- 独立 GnuPG 目录，不读本机密钥环。导入前核对主指纹；仅接收该主钥或其有效子钥的 `VALIDSIG`，拒绝错误、过期或吊销签名。签名失败立即停止，无“跳过验证”选项。
- 验证通过后记录源码包、签名、公开钥 SHA-256，并将它们和原始 LGPL 许可、配置参数、构建环境、脚本一同保存。下载内容固定到具体已签名版本，但 runner apt 编译器包不锁到不可变快照；因此**不承诺逐字节重现**，以每次产物清单的摘要为准。
- 源码解包拒绝越界、链接、重复成员与过大成员；v09-r2 包复用父任务的 `bundle.py extract`，同时再次绑定已冻结输入摘要和 391 文件。npm 安装禁用 lifecycle scripts，不读用户 npm 配置。
- 只在 runner 上安装构建工具、完整参考 ffmpeg。后者仅生成正弦音合成样本，不进入运行产物。构建、转码实验在无网络 namespace 内、非 root 用户和净化环境下执行。
- runner 的 `GITHUB_TOKEN` 只有 contents:read；无服务端变量、云密钥、ASR、上传音频、服务器连接或新付费服务。脚本不会自动推送、安装到服务器或重启服务。

## 最小功能与原参数

运行组件：`matroska/ogg/mov/wav` demuxer；`opus/aac/pcm_s16le/pcm_s24le/pcm_f32le` decoder；`opus/aac` parser；`pcm_s16le` encoder/muxer；`file/pipe` protocol；`aformat/anull/atrim/aresample` 等必要基础 filter。关闭网络、外部库自动检测、设备、ffplay、swscale 和 postproc；不启用 GPL、nonfree 或 version3。

原代码的 `-f s16le` 对应 configure 的 **pcm_s16le muxer**。`-ac 1 -ar 16000` 需要 aresample/swresample；ffmpeg 本身还会拉入少量基础过滤器，不等于开放视频解码。[官方格式注册](https://github.com/FFmpeg/FFmpeg/blob/n6.1.6/libavformat/allformats.c)、[官方过滤图转换逻辑](https://github.com/FFmpeg/FFmpeg/blob/n6.1.6/libavfilter/avfiltergraph.c)。

`media-compat.mts` 直接导入冻结 v09-r2 的 `inspectVoiceAudio` 与 `normalizeVoiceAudio`，不是重写一个等价实现。显式 `.mts` 避免依赖 sparse checkout 之外的 package.json 模块类型。校验其源摘要后使用新构建的两个绝对路径，保留应用原来的受限环境、ffprobe 5 秒及 ffmpeg 10 秒时限、1 MiB probe 输出、1,920,000 字节 PCM 上限。临时根是专用 `cat-private-voice-media-*`，仅启用既有 synthetic-files-v1 模式，不连 PG。

实验包括：三种 WAV PCM、立体声、44.1/48 kHz、WebM/Opus（含 pipe 生成的未知时长容器）、Ogg/Opus、MP4/AAC（含碎片 MP4）；60 秒边界与 61 秒拒绝；假魔数、截断、错误 MIME、空/超大输入、双音轨、音视频混合、不支持编码、预先取消；两次并行 60 秒转换与每次清理。输出核对 WAV 头、16 kHz/单声道/16bit、采样长度、非静音且未削波。运行中取消和故意超时注入未包含。

注意：参考编码器生成的 60 秒 AAC/Opus 可能暴露容器 padding 与应用边界处理的不兼容。若出现失败，保留 FAIL 证据，不能把预期改成通过或静默截断。

## 依赖、容量和许可

ELF 必须只有 `libc.so.6`、`libm.so.6` 依赖，解释器为 `/lib64/ld-linux-x86-64.so.2`，无 RPATH/RUNPATH，最高 GLIBC 数字版本不大于 2.39，无私有 GLIBC ABI 或 x86-64-v2/v3/v4 最低硬件要求。`--enable-static` 只指 FFmpeg 库，不是静态 glibc。目标主机仍须读取既有 libc/解释器状态，并用原参数实际运行；不能以相同 Ubuntu 名称代替这一步。

用 `/usr/bin/time -v` 分别测两种 60 秒合成输入的 ffprobe/ffmpeg，单进程峰值 RSS 门槛 128 MiB，同时保留构建和应用原函数实验的资源记录。这个预算只是候选筛选阈值，不能证明目标 2GB 主机、完整应用 cgroup 或生产并发容量。`-max_alloc` 是单次分配限制，不是整个进程的内存上限。[FFmpeg 参数文档](https://ffmpeg.org/ffmpeg-all.html)。

资源微测使用 v09-r2 的 packet 字段和 AAC frame 探测，并针对已校验 SHA 的固定 48kHz/60秒合成 AAC 使用 `atrim=end_sample=2880000`；该值来自明确样本配方，不充当生产时间证明。生产证明、实际条件分支和共享探测期限仍由未放宽的实际函数兼容路径执行。额外 frame 微测沿用每次 5 秒、转码 10 秒及 128 MiB 门槛，不将各微测独立时限误写为共享预算验证。合成样本清单提前保存，便于失败时保留样本摘要。

默认 FFmpeg 源码主要适用 LGPL 2.1+，可选 GPL/nonfree 功能会改变条件。本配置不启用这些开关，携带未修改对应源码、签名、许可证、配置和重建脚本；实际二进制的 `-version` 也会检查构建选项。这是溯源及许可材料准备，不替代针对最终分发方式的法律判断。[官方许可说明](https://ffmpeg.org/legal.html)。

## 父任务发布映射与运行

1. 审核本目录后，将准备文件复制到独立公开构建分支的 `.ci/e4e-media/`；将 `e4e-media-build.yml` 复制到 `.github/workflows/`。保留原 `.ci/e4e-linux/bundle.py` 和 `voice-build-input/`。
2. 此子任务不自行 push。父任务发布后的 workflow 只运行 runner，不触达观察服务器。
3. 网络准备：`bash .ci/e4e-media/prepare-media.sh "$RUNNER_TEMP/e4e-media-work" "$GITHUB_WORKSPACE/voice-build-input" "$GITHUB_WORKSPACE/.ci/e4e-linux/bundle.py"`。
4. 无网络构建及实验：workflow 用 `unshare --net` + `setpriv` + `env -i` 调用 `build-media.sh`，不建议手动绕过环境守卫。
5. 只有全部必要检查成功才上传 `e4e-media-candidate-<commit>`；失败仅上传 evidence，不上传可被误当已通过的二进制。下载产物后必须校验 `SHA256-MANIFEST.json`、`evidence/result.json` 和实际 CI commit。
6. 产物即使标为 `PASS_LIMITED_CI`，仍需父任务独立复核后才能安排目标机兼容实验。建议后续独立、只读版本目录保存二进制，通过 E4_VOICE_FFMPEG/E4_VOICE_FFPROBE 绝对路径引用；本包没有安装命令。

本机准备检查可执行：`bash -n prepare-media.sh build-media.sh`、`python3 test-preparation.py`，以及 Python/TypeScript 静态解析。它们不是 Linux 构建、媒体转换、真机录音或 ASR 验收。
