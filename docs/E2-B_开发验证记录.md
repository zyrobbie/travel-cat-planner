# E2-B 开发验证记录

开发日期：2026-09-13 至 2026-09-14。执行：程序员 Astra 轻。依据 `E2-B_程序员执行任务书.md` 和根目录完整方案的当前有效决策、第 7 节。本记录只说明本机实现与测试；独立验收、提交、远程 CI 和上线由统筹另行记录。本任务未自行 commit/push。

## 实现与边界

沿用原 GitHub Pages 应用路径及 `cat-letters-pages-v1` / `participants`，数据库版本与记录 schema 升至 3。关闭网页没有后台代码运行；打开、刷新、选回体验、返回前台和页面可见期间每 15 秒检查到期节点。检查无到期节点时不 put、不广播。没有暂停按钮、PAUSED、HELD、Push、服务端 REALTIME 或自动语义匹配。

需求卡和明信片共用一个未读位置，以 `read_at` 为准。日历按计划时间、稳定排序号依次处理：第一封合法信可入盒，其后的占位节点记录跳过，不排队。旅行开始与结束照常结算到当前时刻；已寄信不因回家而删除。旧版多封未读原样保留，全部读完前不新增。

读信事务先结算已到期节点，再写已读，避免先释放位置补出旧信。提交成功返回完整状态及首读标记，详情展示不再依赖另一轮读取；提交失败仍保持原未读。单独保存的 reply/edit 草稿不算有效回应来源，没有未读时硬刷新恢复编辑；有未读时返回首页优先显示新信，草稿留在原卡。编辑期间新信到达只显示“有一封新来信”入口，点击回首页不标已读、不清草稿；发送成功、实际更正、删除和合成拦截清理对应草稿。草稿保存提示与回应提交提示分开。

人工寄信、日历寄信共用正文与未读检查；每旅行最多一封、同正文不重复、当前安全状态与来源均须有效。普通入口明确为“寄出普通旅行信”。已有 SELECTED 时，普通入口和状态层均拒绝静默替换，需明确“改选为这篇普通故事”，再寄出已选结果。人工审核不会改变旅行场景；当前旅行场景固定，来源更正使联动失效，但不改目的地。选择和寄出都先检查到期日历，过时页不能在旅行结束后补建审核或补寄；拒绝事务回滚后，下次正常读取仍可完整结算。

## 日历工程默认

- `calendar.version=1`，记录初始化基点、固定日历基点、非负演示偏移、已处理时间高水位、稳定节点 ID/顺序、节点结果和已处理数量。
- 新体验从命名时初始化。D1 是基点后 24 小时；固定 12 个节点：D1 礼物 D-03、D3 陪伴 D-04、D5 抓虫 D-02、D6 萤火虫出发、D7 寄信、D8 回家、D9 泡泡 D-05、D10 阿橘 D-01、D11 鱼干 D-06、D12 灯塔出发、D13 寄信、D14 回家。属于有限工程日历，不是用户作息或长期内容承诺。
- 旧版正在旅行的原 `trip.id` 不改。升级基点 +24 小时新增一次寄信机会，+48 小时新增回家节点；这些是新增剩余安排，不冒称原旅已有时间。场景优先取当前旅行最近 SELECTED/NEEDS_REVIEW 的故事，再取该旅已寄信场景，否则明确默认莱茵河。已有明信片时剩余寄信节点跳过。
- 存在旧旅行时，后续固定 14 日日历从升级后 +48 小时起算，即固定 D1 在升级后 +72 小时；没有旧旅行则直接从升级基点起算。不倒推旧建档日期，不在升级瞬间补旧事件。
- 手动出发也追加 +24 小时寄信、+48 小时结束两节点，使用出发前选定场景和确切 tripId。固定出发遇到已有旅行时跳过，不替换原旅、不挪动固定日历；所有结束节点只作用于自己的 tripId。手动结束不使稍后的旧结束节点误结束新旅。同一时刻按已持久化排序号处理，后追加手动节点排在既有同刻节点之后。
- “演示快进到下一节点／日历末尾”只调整此参与者的持久非负时间偏移，调用同一结算器。刷新保留，不改系统时钟或其他猫。时钟倒退不重放已结算节点；大幅前跳只处理有限已知节点。内容耗尽不循环重寄，保留回看及人工演示。
- 自动寄信只用本旅行同场景、当前有效、未重复投递的人工联动选择，否则用同场景 ordinary；ordinary 也不可用则跳过，不临时编正文。手动操作不是自动补发遗漏队列，仍须逐次满足当前旅行、内容、未读、来源和安全约束。

日历信新增 `planned_at`、`effective_at`、`calendarNodeId`，`delivered_at` 和节点 `writtenAt` 是实际写入时刻。演示未来时间与实际写入日期分别保存，不伪造网页关闭期间已经执行。

## 旧数据与草稿

迁移对所有参与者使用同一个 IndexedDB versionchange 事务。旧猫、信 ID、正文、收到/阅读/跳过时间、回应版本及删除标记、sourceRefs、review、旅行 ID、tripCount、事件和幂等请求保留。E0＋E1 schema 1 可直接升级，旧回应时间未知仍为 null；schema 2 沿用全部回应历史。未知/损坏版本或部分升级不一致会停止，保留原数据。

草稿按参与者记录内的需求卡 ID 保存，附 reply/edit 类型及预期回应身份/版本，每次输入使用独立事务。它们不进入 review 来源或 RESPONSE_SENT 历史。更正/删除与草稿清理同事务，旧版本草稿写入会被拒绝，不能复活删除内容。UI 明确区分“正在保存草稿”“本机草稿尚未发送”和正式“送出去啦。”。保存失败不伪称完成。真实用户浏览器存档未复制到测试或仓库。

## 本地命令与结果

环境：macOS、Node 22.17.1、Playwright Chromium。390×844 和 1280×900 为桌面浏览器视口，未当作实机手机、Safari、微信或后台 Push 验证。

```sh
npm run typecheck
npm run content:check
npm run pages:build
npm run pages:test:e2b
npm run pages:test:e2a
npm run pages:test
npm run build
# 应用冻结后的迁移回滚证据补强
npm run pages:test:e2b -- upgrade.spec.ts
```

| 检查 | 结果 |
| --- | --- |
| TypeScript / 静态 build | PASS |
| 冻结内容 | PASS；DEMAND 6、ORDINARY 3、LINKED 3、TIP 6、SYSTEM 53 |
| E2-B 完整矩阵 | 14/14 PASS，20.5 秒 |
| E2-A 相关回归与 E0 直接升级 | 12/12 PASS，21.1 秒 |
| 原 Pages 回归 | 3/3 PASS，6.0 秒 |
| 保留 Node 工程 build | PASS；其源文件未改，本轮不重跑数据库集成测试 |
| 迁移补证单独执行 | 2/2 PASS，7.0 秒；后续最终 14 项已包含此强化用例 |
| `git diff --check` | PASS |

E2-B 包括 reply/edit 两类草稿在冷返回及前台 focus 的四组合未读优先验证，以及：空位/占位情况下分段结算与一次跨日结果等价（排除真实写入时间等观测字段）；无到期 put 计数为 0；读前结算与不补旧信；零回应、读完不回、跳过；旅行信保留到回家后首读；独立时钟快进与重复请求；时钟倒退/大幅前跳；双页返回和读取并发；写失败回滚；旧旅与新旅冲突；当前来源删改/拦截及已使用 linked 的普通回退；硬刷新草稿恢复；普通误投防护；迟到直接操作拒绝及后续读取正常。

读取故障测试在 read 的真实 put 事务 complete 后才拦截 **get(id)**，覆盖 `readState → settleCalendar → write → get` 路径。先断言首读详情可见，再主动 focus，确认失败计数大于 0 且详情仍在；不是只拦截无关 getAll 的假阳性。另注入 read put 失败，确认未读名额不释放。

原回归适配保留既有业务断言：草稿恢复后直接使用原输入框；失败更正前单独等待草稿落库，仍比较失败事务前后全状态一致；更正/寄出的真正双页并发通过两页真实 store 事务同时发起，避免广播先更新按钮导致点击等待。用户点击、确认、跨页来源刷新另有原 UI 用例覆盖。

## 真实旧程序与回滚证据

- E2-B 测试从精确 E2-A 应用提交 `ce2c31f0b3d47ae04137beacf6de76b0752b901c` 构建旧程序，复现已发布入口 `index-BPnXbb4F.js`。通过旧 UI 建立多猫、多封未读、已读未回、已回、已改/已删、NEEDS_REVIEW 萤火虫、SELECTED 莱茵河和进行中的旅行，再在同 origin/base 切换新版，逐字段比较所有原记录。
- 应用冻结后的补强测试保留原 `IDBCursor.update`，第一条真实 update 请求成功后，第二条才抛失败；断言 `attempts=2, successes=1, failedAfterSuccess=true`。随后数据库版本与每条旧记录全部等于 before，刷新重试正常升级，删除原文不复活。
- E0 直接升级继续使用已发布 `288f71225c4a48139af43f30bed1429710deed0e` 旧程序生成数据。不是仅手造对象模拟兼容。
- 时钟模拟通过测试浏览器时钟完成；另有真实关闭页面、等待短时测试节点到期、重新打开的独立用例。后者只在隔离合成记录中缩短测试日历，仍使用真实本机时间，单独证明关闭期间无运行也能返回结算。
- E2-A 和 E2-B 服务器/测试模块分别使用 4180/4181 与 `.local/e2a-store` / `.local/e2b-store`，不共写模块。测试时钟和 store 模块没有加入公开应用入口。发布白名单仅从 `dist/pages/app` 和原公开策划页打包，测试模块、.local 和浏览器存档不进入发布包。Pages workflow 增加 E2-B 检查；远程执行结果由统筹发布后确认。

## 文件与证据

应用：`static-app/{model,database,store,App,Control,ResponseManager,ReviewPanel}.tsx/ts`，新增 `calendar-plan.ts`、`calendar.ts`、`delivery.ts`、`CalendarPanel.tsx`。测试：`tests/e2b`、`static-app/e2b.playwright.config.ts`、`scripts/{prepare-e2b-baseline,e2b-test-server}.mjs`；适配原 Pages/E2-A 用例；更新 package 脚本与 Pages workflow。统筹负责的 README、计划、任务书、E2-A 发布记录及 output 未覆盖。

本机证据均为合成数据：

- `/tmp/catletters-e2b-evidence/real-v2-upgrade.json`：完整 before、after、日历推进后记录。
- `/tmp/catletters-e2a-evidence/real-old-upgrade.json`：E0 直接升级记录。
- `/tmp/catletters-e2b-evidence/calendar-mobile.png`、`upgraded-calendar-desktop.png`。
- `/tmp/catletters-e2b-evidence/restored-reply-mobile.png`、`restored-edit-mobile.png`、`restored-edit-desktop.png`、`new-mail-during-edit-mobile.png`。
- `/tmp/catletters-e2b-{tests,e2a-regression,pages-regression,upgrade-final,typecheck,content,build,node-build}.log`。

上述实际 PNG 已查看：正文、草稿提示、按钮与控制台在相应视口可读，无横向溢出、重叠或被底栏遮住。仍保留内部占位图，不声称 E3 视觉交付。

## 五步体验

1. 在原浏览器/路径打开新版，继续原猫；原信和原旅行保留。
2. 点“演示推进”，选择该猫，点击“演示快进到日历末尾”。
3. “进入此体验”，查看当前在家状态与保留下来的那封未读信；旧版多未读仍全部保留。
4. 打开阅读，不需要回复；回到主页或刷新，不会立即补出跳过的旧节点。
5. 在需求卡输入草稿，看到保存提示后刷新；无未读时恢复编辑，有未读时先显示首页，再打开原卡仍保留文字，均不自动发送。

## 应用冻结标识

应用冻结入口 `index-CsL8Yg1C.js`，SHA-256 `32bc3053e26c5b0ecb1c56840b19836417112f262ceca57585c074842920a319`。CSS 仍为 `index-DI-DoRUE.css`。冻结内容 SHA-256 `df48989c0e898b4c0df5df2c478524181d7ba76efa6cd22e627d430834a342f7`，未改正文。

首次冻结后补强了“第一条真实更新成功后第二条失败”的迁移测试。随后按统筹明确指示只修复草稿返回入口：冷返回未读优先、编辑中到信仅提示；已重建并完整重跑 14＋12＋3 项，以上为重新冻结后的资产与结果。当前为本地完成、待统筹最终复核；不等于已经发布或获得用户验收。
