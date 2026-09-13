# E2-A 开发验证记录

日期：2026-09-13。执行：程序员 Astra 轻。此记录为本地开发证据；最终独立验收、提交与上线状态由统筹维护在 `E2-A_验收与发布记录.md`。本任务未自行 commit 或 push。

## 已实现

- 原库 `cat-letters-pages-v1` / `participants` 原子升级至 IndexedDB 版本 2、记录 schema 2。保留原参与者和信件身份、猫名、历史正文、阅读/跳过/收到时间、回应、旅行和控制历史；旧回应缺失的回应时间仍为 null。
- 三篇冻结 linked 按 claim 人工核验本体验的实际回应版本。界面完整展示需求卡情境及回应全文，证据范围明确为全文，不默认勾选，不自动判断语义。礼物需同时满足两项；不足、否定、条件或情境不符选择完整 ordinary。待寄区显示实际将寄出的正文标题。
- 选择与寄出分开；寄出事务再次校验版本、旅行和单次投递约束。旅行开始/结束独立，不以回应或核验数量作为触发条件。
- 首读（包括来信盒首次打开未读信）不显示来源；已读后可主动展开寄出时的实际旧版本。更正标记与旧文一起显示；删除后只显示删除状态，旧故事正文保持寄出快照。
- 回应更正使用预期版本及幂等键。删除在同一事务清空所有版本正文、当前投影并使未寄联动失效；引用和请求仅保存 ID、范围及状态，没有另存原文摘录。首次发送也带原回应身份，删除后的旧首次发送重试不能复活原文；主动重新回应产生新身份。
- 未实现 E2-B、REALTIME、LLM、云账户或已取消的自留句。Node 后端、共享用户页和冻结内容未修改。

## 变更范围

应用：`static-app/App.tsx`、`Control.tsx`、`local-api.ts`、`store.ts`；新增 `model.ts`、`database.ts`、`ReviewPanel.tsx`、`ResponseManager.tsx`、`SourceHistory.tsx`。

检查：`tests/e2a/{helpers,linked.spec,upgrade.spec}.ts`、`static-app/e2a.playwright.config.ts`、`scripts/{prepare-e2a-baseline,e2a-test-server}.mjs`；原静态用例只更新读库版本和具体错误断言；`package.json` 新增 `pages:test:e2a`；Pages workflow 在打包前运行它。

文档：本记录及按统筹授权更新 README 上半部的静态能力与记录链接。其他任务书、统筹验收文件、策划首页和既有产物由统筹负责。

## 复现与结果

环境为本机 macOS、Node 22.17.1、Playwright Chromium。390×844 和 1280×900 是桌面浏览器视口，不代表真实手机、Safari、微信或其他浏览器。

```sh
npm run content:check
npm run typecheck
npm run pages:build
npm run pages:test:e2a
npm run pages:test
npm run build
```

| 检查 | 本地结果 |
| --- | --- |
| 冻结内容完整性 | PASS；DEMAND 6、ORDINARY 3、LINKED 3、TIP 6、SYSTEM 53 |
| TypeScript | PASS |
| 静态构建 | PASS |
| E2-A Chromium | 12/12 PASS |
| 原 E0＋E1 静态回归 | 3/3 PASS |
| 保留 Node 工程构建 | PASS；本轮未修改其源文件，未重跑后端数据库集成测试 |
| `git diff --check` | PASS |

E2-A 用例覆盖三篇 linked 实际投递、礼物缺一项/否定/条件与情境不符、完整 ordinary 回退实际投递、仅跳过旅行、首页及来信盒首读、旧版本回看、更正/删除和原文清除、过时编辑及首次请求不能复活、两页 Promise.all 并发删/改与寄出（依据事件提交次序核对）、重复更正/选择/寄出、另一参与者草稿保留、跨参与者引用在存储边界拒绝、写失败、合成 UNAVAILABLE 和 INTERCEPT。

## 真实旧版升级证据

`pages:test:e2a` 从已发布应用提交 `288f71225c4a48139af43f30bed1429710deed0e` 提取并构建真实旧程序，其入口精确复现 `index-DJLlvRK6.js`。浅克隆缺少该提交时，脚本按固定 SHA 获取；不会使用可漂移分支替代。

隔离浏览器在同一 origin `http://127.0.0.1:4180` 和同一 `/travel-cat-planner/app/` 上先加载旧程序，通过实际 UI 建立两只合成猫、回应、跳过、已读及未读普通旅行信、进行中的旅行，再切换新程序。比较所有旧 participant、trip、tripCount、controlRevision、events、requests 和 letters 字段；新增 responseId 除外，旧字段逐项一致。双页升级、刷新、继续原旅行与管理旧回应通过。

升级故障分别覆盖 cursor 更新抛错后整库回滚、未知 schema 保留原记录、恢复后成功升级、已有数据库缺少 participants 不新建空库、schema 2 孤立 ACTIVE 回应拒绝。所有样本均为测试生成；未复制真实用户浏览器数据。

测试专用真实 store 模块仅构建于忽略目录 `.local/e2a-store`，用于非法引用与幂等边界调用；不暴露在应用入口，也不包含在 `dist/pages/app` 或发布脚本的输入中。Pages 发布 workflow 已加入完整 E2-A 检查，本地成功不能替代后续远程 workflow 结果。

## 页面与本机证据

已实际查看 PNG：首读、展开来源、更正管理、删除来源及人工核验控制台。390px 正文和按钮可读、无横向溢出或遮挡；1280px 来源和管理页可读。图片仍为明确内部占位。

- `/tmp/catletters-e2a-evidence/real-old-upgrade.json`：旧版及升级后合成记录逐字段快照。
- `/tmp/catletters-e2a-evidence/linked-first-mobile.png`、`linked-sources-mobile.png`、`linked-sources-desktop.png`。
- `/tmp/catletters-e2a-evidence/manager-mobile.png`、`manager-desktop.png`、`upgraded-management.png`、`deleted-source.png`、`manual-review-mobile.png`。
- `/tmp/catletters-e2a-{build,typecheck,content,tests,e1-regression,backend-build}.log`：命令日志。

统筹另以其独立旧版 profile 检查升级链，证据与范围由统筹记录；不将其混写为本开发脚本新跑的结果。

## 最短人工体验

1. 保留原浏览器数据，在原应用路径打开新版；原猫与信件继续存在。
2. 已有需求回应可在来信盒打开并“管理这条回应”。需要新样本时仅在隔离合成体验内新增回应。
3. 控制台独立开始旅行，选故事，逐项查看情境与回应、选择人工判断并确认，先核验选择，再寄出。
4. 打开信首读、收好后从来信盒重开并展开来源。回到原需求卡更正/删除，再回看已寄来源状态。
5. 先选择未寄 linked 再更正或删除来源，核验会失效；重新核验或选普通故事仍可完成旅行。

## 最终冻结标识

应用入口 `index-BPnXbb4F.js`，SHA-256 `29d62fd628092a1422c38c2de46161a088b18503ce8dfac303dbb04117a47e11`；CSS 沿用 `index-DI-DoRUE.css`。冻结内容文件 SHA-256 `df48989c0e898b4c0df5df2c478524181d7ba76efa6cd22e627d430834a342f7`，本轮无差异。最后一处应用修正仅让普通回退待寄区显示实际普通故事标题；最终 E2-A 12/12 用时 20.7 秒。

原静态回归的同文双页发送场景明确关闭第二页 BroadcastChannel，保留过时表单来验证重复写入；否则第一页的正常实时刷新可能在 Playwright 点击前移除第二页按钮，导致用例等待已不存在的按钮。E2-A 的真实双页广播、并发删改/寄出仍保留；不是关闭产品同步功能。
