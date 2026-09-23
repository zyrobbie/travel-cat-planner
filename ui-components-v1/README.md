# 有猫来信 · 核心 UI 组件 V1.0

**首版设计提案，待用户与团队验收。**

在线预览：https://zyrobbie.github.io/travel-cat-planner/ui-components-v1/#overview

## 从这里开始

1. 打开 [index.html](index.html)，使用顶部导航查看五类组件与状态。
2. 看 [总览图](designs/00-overview.png)，再分别查看默认、交互和内容变化。
3. 设计或开发交接请读 [组件规范与使用说明](组件规范与使用说明.md) 和 [tokens.json](tokens.json)。

解压后保留本目录结构，HTML 引用同目录的样式、脚本和原图，没有外部字体或网络资源依赖。若浏览器限制直接打开本地 HTML，可在本目录运行 `python3 -m http.server 8000 --bind 127.0.0.1`，访问 `http://127.0.0.1:8000/`。

## 交付内容

- 5 类组件：日常需求卡、旅行明信片、猫咪选择卡、回复输入、成长记录。
- 7 张桌面设计板：总览、5 个组件状态板、基础规范。
- 5 张 390px 移动尺寸图；选猫图保留两行四猫的完整长度。
- 可点击 HTML、可编辑 CSS / JavaScript、设计变量 JSON、组件说明。
- 13 张原始引用素材及来源哈希；所有角色与场景未经改画、裁切或调色。

### 直接看组件

| 组件 | 默认 / 交互 / 内容变化 | 移动尺寸 |
|---|---|---|
| 日常需求 | [状态板](designs/01-daily.png) | [390px](designs/mobile-01-daily-390.png) |
| 旅行明信片 | [状态板](designs/02-postcard.png) | [390px](designs/mobile-02-postcard-390.png) |
| 猫咪选择 | [状态板](designs/03-choice.png) | [390px](designs/mobile-03-choice-390.png) |
| 回复输入 | [状态板](designs/04-reply.png) | [390px](designs/mobile-04-reply-390.png) |
| 成长记录 | [状态板](designs/05-growth.png) | [390px](designs/mobile-05-growth-390.png) |

## 本轮边界

交互是本地设计演示。语音不录制、不转写，回信不发送、不存储，选猫不完成领养。示例称呼、文案、色值及组件尺寸均等待本轮验收。完整页面与真实业务接入留待后续阶段。

线上预览供团队审阅提案；发布不代表设计定稿。
