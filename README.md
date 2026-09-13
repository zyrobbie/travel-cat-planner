# 有猫来信 · E0＋E1 内部应用

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
仅重新提取冻结内容时需要原收口包：`python3 scripts/import-content.py /path/to/02_原型规格与内容`。普通启动与部署直接使用已入库的 `src/content/frozen.json`，不依赖开发者本机原文目录。

- 冻结内容：6 demand、3 linked（仅导入）、3 ordinary、6 tips、53 合法系统词条。保留来源与正文哈希，负例不会作为可用词条。季节与时段分开记录。
- `SAFETY_ADAPTER=synthetic-v1` 仅对明确的 `[SYNTHETIC:INTERCEPT]`、`[SYNTHETIC:UNAVAILABLE]` 测试输入分流；没有真实识别能力。拦截内容不写普通历史；安全覆盖阻止普通投递。
- 不含 E2 的 linked 投递、来源管理、更正删除、暂停恢复、自留句或 REALTIME worker；页面不提供这些伪入口。

## 部署

这是常驻 Node＋PostgreSQL 应用。GitHub Pages 只保留原策划文档站，不能运行本应用后端。尚需确定实际托管平台和数据库；没有创建付费资源。

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
