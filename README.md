# 有猫来信 · GitHub Pages 本机体验版

[打开本机体验](https://zyrobbie.github.io/travel-cat-planner/app/)（线上已发布基线为 E0＋E1；E2-A 本地开发与发布状态见 [验收记录](docs/E2-A_验收与发布记录.md)）。无需安装 Node 或 PostgreSQL，首次打开直接给小猫起名。

1. 起名后，点击右上角“演示推进”，投递一张需求卡，再进入体验。
2. 回应或选择“这次先不回”；回应成功只有“送出去啦。”。
3. 在演示控制台独立开始旅行、选择旅行故事并寄出；不回应也能旅行。
4. E2-A 在控制台逐项人工核验实际回应来源，再单独寄出联动故事；来源不足选择完整普通故事。
5. 首读只看完整故事；收好后从来信盒重开，可展开寄出时使用的回应版本。
6. 已回应需求卡可“管理这条回应”进行更正或删除；未寄联动失效，已寄故事正文保留。旅行仍独立开始与结束。

**数据仅保存在此浏览器，清除浏览器数据后可能丢失。** 没有云端账号或跨设备同步。本机控制台可切换或新建体验，新建不会覆盖旧体验；从不带编号的原始链接返回，可以“继续已有体验”。各体验只是本机数据分区，不是安全隔离，请使用合成内容。

页面通过 IndexedDB 事务保存，成功确认只在事务提交后出现。两标签页的重复回应只保存一次；过时控制台操作要求先刷新。存储不可用／空间不足时明确报错，不假报成功。没有虚假密码／邀请码后台、不接 LLM。E2-A 来源核验由人完成，不做自动语义匹配或 E2-B 暂停恢复；图片仍为明确标注的内部占位。

沿用原 IndexedDB 名称及参与者链接原子升级，保留原猫、来信、回应和进行中的旅行。旧回应时间未曾记录，升级后保持未知；遇到未知版本或损坏数据会停止并提示保留数据。删除会清除全部回应版本正文，过时页不能将旧版本保存回来。

## 静态版开发与检查

```sh
npm ci
npm run pages:build
npm run pages:preview
# http://127.0.0.1:4173/travel-cat-planner/app/
npm run pages:test
npm run pages:test:e2a
```

`pages:build` 只输出 `dist/pages/app`，默认 base 为 `/travel-cat-planner/app/`，可用 `PAGES_BASE` 覆盖。旧策划站和 Pages 发布 workflow 由整合脚本单独处理。静态版不需要 `.env`、管理员密钥或数据库。

测试覆盖真实浏览器 IndexedDB 读写、刷新、裸链接继续、双击／两页重复、零回应旅行、本机分区、故障写入、延迟读取切换和发送期间切换保护，以及 390px／1280px 截图。运行前如未装浏览器：`npx playwright install chromium`。

E2-A 另覆盖真实已发布旧程序产数后的同源升级、联动来源与删改并发。旧版测试固定应用提交 `288f71225c4a48139af43f30bed1429710deed0e`，浅克隆缺少该提交时会获取它；测试模块仅在本机测试服务器使用，不打入发布产物。详细结果见 [Pages 开发记录](docs/Pages_开发验证记录.md)、[E2-A 开发记录](docs/E2-A_开发验证记录.md)及 [E2-A 验收与发布记录](docs/E2-A_验收与发布记录.md)。

以下 Node＋PostgreSQL 版本仍完整保留，属于另一种运行方式；GitHub Pages 不运行这些服务。

---

## 保留的 Node 后端工程（E0＋E1）

本轮提供真实 PostgreSQL 持久化的首条普通旅行闭环：命名 → 需求卡 → 回应／跳过 → 独立旅行 → 完整明信片 → 来信盒 → 回家。尚未进入 E2，也未开放真实用户测试。

## 最短本地启动

需要 Node.js 22.17.1（本轮实测）、npm、PostgreSQL 17。

```sh
npm ci
# macOS 尚无 PostgreSQL 时：brew install postgresql@17
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
node scripts/setup-local.mjs
npm run db:migrate
npm run build
npm start
```

打开 `http://127.0.0.1:3100`，Admin 位于 `/admin`。独立本地数据库监听 `127.0.0.1:55432`，文件位于 `.local/postgres`。启动脚本生成 `.env`，不会打印秘密或覆盖已有环境文件。已有 PostgreSQL 可直接按 `.env.example` 配置 `DATABASE_URL`，跳过 setup-local。

管理员密钥从本机 `.env` 的 `ADMIN_SECRET` 安全取得；不要发到聊天或提交仓库。在 Admin 建立匿名参与者，将一次性邀请码在用户页输入，完成命名，再从 Admin 人工投递。邀请码丢失、兑换响应丢失或会话过期，可在 Admin 为同一参与者“重发邀请码并撤销旧会话”，历史保留。`npm run demo` 也可建立空白合成走查参与者，邀请码写入受限 `.local/demo-invite.json`，不会预填假回应。

当前研发验收用持续进程通过 `node scripts/start-local.mjs` 启动，PID/日志分别为 `.local/app.pid`、`.local/app.log`。这是本机验收进程，不是开机自启服务；系统关机后按启动说明恢复。数据库可用 `pg_ctl -D .local/postgres status` 检查。

## 五步走查

1. Admin 建参与者；用户页输入邀请码、起名。
2. Admin 投递下一需求卡；用户刷新并发送文字或跳过。发送确认只有“送出去啦。”。
3. Admin 独立开始旅行，与回应数无关。
4. Admin 选取 ordinary 并投递；用户刷新、阅读全文、收好并从来信盒回看。
5. Admin 结束旅行回家；用户刷新，关闭再打开仍可回看。

## 检查与数据边界

```sh
npm run content:check
npm test
npm run build
npx playwright install chromium
# 另一个终端保持 npm start 运行
npm run test:e2e
```

单元／集成测试只创建合成参与者并清理自己建立的记录。端到端测试留下合成参与者及 `.local/restart-session.json` 供重启检查（含会话，禁止提交），截图放 `/tmp/catletters-evidence`。不要在正式用户数据库运行测试。

- 服务端参数化 SQL、邀请摘要、HttpOnly 会话、Origin 校验、限流和归属校验。HTTPS 部署必须设置 `COOKIE_SECURE=true`。
- 一张需求卡最多一个回应；用户发送与 Admin 推进支持幂等。单次旅行最多一张明信片，同故事不重复投递。
- 冻结内容：6 demand、3 linked（仅导入）、3 ordinary、6 tips、53 合法系统词条。保留来源与正文哈希，负例不会作为可用词条。季节与时段分开记录。
- `SAFETY_ADAPTER=synthetic-v1` 仅对明确的 `[SYNTHETIC:INTERCEPT]`、`[SYNTHETIC:UNAVAILABLE]` 测试输入分流；没有真实识别能力。拦截内容不写普通历史；安全覆盖阻止普通投递。
- 不含 E2 的 linked 投递、来源管理、更正删除、暂停恢复或 REALTIME worker；页面不提供这些伪入口。
- 2026-09-13 规划修订：用户已取消“留给自己的话”及自留句相关入口、存储与管理能力，后续开发不再包含该板块；其他产品机制和 GitHub Pages 发布选择不变。

仅重新提取冻结内容时需要原收口包：`python3 scripts/import-content.py /path/to/02_原型规格与内容`。普通启动与部署直接使用已入库的 `src/content/frozen.json`，不依赖开发者本机原文目录。

## 保留后端的可选部署方式

本轮只发布 GitHub Pages 静态本机体验版和策划站，不部署云后端，也无需先选择其他托管平台。以下仅为保留的常驻 Node＋PostgreSQL 工程提供可选运行说明；GitHub Pages 不承担其服务端功能。没有创建付费资源。

部署环境：`DATABASE_URL`、`APP_ORIGIN`（精确 HTTPS 来源，无尾斜杠）、至少 32 字符随机 `ADMIN_SECRET`、`APP_MODE=INTERNAL`、`SAFETY_ADAPTER=synthetic-v1`、`COOKIE_SECURE=true`、可选 `PORT`。

发布过程：`npm ci` → `npm run db:migrate` → `npm run build` → `npm start`。迁移使用版本和校验和，事务锁防并发，已应用迁移不可改写。首次导入整包事务完成。健康检查 `/api/health` 会真实检查数据库；个人 API 均 `private, no-store`。

也提供 Dockerfile（同样运行 `npm start`）。迁移在发布步骤使用源码和开发依赖单独运行，再启动容器；数据库必须使用持久卷或独立托管实例，不能放在应用容器的临时磁盘。Docker 容器本轮尚未实际构建，因为本机未安装 Docker。

CI 在 GitHub Actions 使用 PostgreSQL 17.11，运行迁移、测试、build、Chromium 端到端；本地对应命令已执行，远程 CI 结果由实际推送后的运行判定。

---

## 原策划文档站（保留）

以下为原有站点的历史说明；V2.1 文档保留供回溯，当前 E0＋E1 的运行与验收说明以本 README 上半部及 `docs/E0-E1_验收与部署记录.md` 为准。

# 有猫来信 · travel-cat-planner

一款心理陪伴型产品的项目规划文档站，由 GitHub Pages 托管。

**产品名称**：有猫来信（2026-09-09 定名，原名「旅行小猫」）
**线上地址**：https://zyrobbie.github.io/travel-cat-planner/

## 站点结构

| 页面 | 文件 | 说明 |
|------|------|------|
| 目录页 | `index.html` | 项目规划文档总目录（首页） |
| 文档阅读器 | `doc.html?doc=<key>` | 统一渲染 `docs/` 下的 md 文件 |
| 待决策议题 | `decisions.html` | 选择题选项卡 + 开放题作答，生成「问题+答案」汇总页供截图 |

## 文档源文件（docs/）

| key | 文件 | 内容 |
|-----|------|------|
| `idea` | `docs/idea.md` | 《有猫来信初始想法》V2.1（项目逻辑基准） |
| `manual` | `docs/manual.md` | 有猫来信项目执行总纲 V2.1（单一事实来源） |

## 更新方式

文档更新：替换 `docs/` 下对应 md 文件 → commit → push，Pages 自动重新部署，无需改 HTML。

> 由产品战略团队 AI 协作推进 · 重要决策由产品负责人审定
