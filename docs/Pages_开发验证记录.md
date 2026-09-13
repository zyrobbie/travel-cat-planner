# GitHub Pages 本机体验版 · 开发验证记录

日期：2026-09-13。依据最新托管选择，本轮增加纯静态本机体验，保留既有 Node＋PostgreSQL 工程。此记录不把本机存储当作云端持久化或服务端账号隔离。

## 交付与入口

- 静态源码：`static-app/`。目录特意避开 Next.js 保留的根 `pages/` 路由目录。
- 构建：`npm run pages:build` → `dist/pages/app`。默认 base `/travel-cat-planner/app/`。
- 预览：`npm run pages:preview` → `http://127.0.0.1:4173/travel-cat-planner/app/`。
- 测试：`npm run pages:test`，配置 `static-app/playwright.config.ts`，自动启动或复用本地预览。
- 最终线上入口由整合任务发布到 `https://zyrobbie.github.io/travel-cat-planner/app/`。发布与线上验收状态以统筹记录为准，本记录只证明本地构建和测试。
- 主代理维护旧策划站打包脚本及 Pages workflow；静态应用不修改其内容。

## 行为与数据边界

首次直接命名，无邀请码或假密码后台。页面提示“数据仅保存在此浏览器，清除浏览器数据后可能丢失”；技术说明集中在折叠帮助和“演示推进”控制台。

P1–P6 保留冻结正文与既有样式。用户发送只有“送出去啦。”，回应不会触发旅行。控制台支持新建／选择本机体验、投递下一卡、独立旅行、选择完整 ordinary、回家。从裸 `app/` 链接回来时，有“继续已有体验”；全新体验不覆盖旧数据。

IndexedDB 数据库 `cat-letters-pages-v1`，版本 1，参与者记录带 schema 版本。修改在同一 readwrite 事务内读取最新记录、校验、写回；只有事务完成才报告成功。写失败不保留内存假成功。回应按参与者内的来信唯一，重复同内容返回同一确认，不同内容冲突。人工推进同时校验请求键与 controlRevision，两个标签页持有旧版本时只允许一个推进，另一个要求刷新。

不同参与者仅是当前浏览器中的数据分区，控制台可以看到并切换所有本机体验，不声称认证或安全隔离。没有跨设备同步、远端恢复或服务端账号。不接 LLM／外部服务；合成安全标记仅测试路由，不具备真实风险识别能力。没有扩展 E2。

## 实际验证

环境：macOS、Node 22.17.1、Vite 8.3.0、Playwright 1.63.0／Chromium 153.0.8010.12。复用冻结内容与 CSS Modules。

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run pages:build` | PASS，输出 index.html 和自包含静态资源 | `/tmp/catletters-pages-build.log` |
| `npm run typecheck` | PASS | `/tmp/catletters-pages-typecheck.log` |
| `npm run pages:test` | 3/3 PASS | `/tmp/catletters-pages-evidence.log` |
| `npm test`（原 DB 测试） | 3/3 PASS | `/tmp/catletters-pages-backend-regression.log` |
| `npm run build`（原 Next 工程） | PASS，原三组路由正常 | `/tmp/catletters-pages-next-build.log` |

静态浏览器测试逐项覆盖：

1. 首次命名→需求卡→真实回应仅系统确认→同日第二回应仍在家→第三卡跳过→独立旅行→完整萤火虫 ordinary→历史回看→回家。
2. 刷新后原参与者和历史保留；离开后从不带 hash 的 `app/` 返回，“继续已有体验”进入原记录。
3. 双击控制台投递只有一封；两个标签页同信并发发送只产生一次 RESPONSE_SENT；两页持同一推进版本只投递一张。
4. 第二本机体验零回应仍能旅行并收到完整 ordinary；切回第一体验能回看自己的回应，不混入另一分区。
5. IndexedDB 禁用时清楚报错；模拟 put 抛出 QuotaExceededError 后，无成功确认，实际 DB response 仍为空。
6. 延迟 IndexedDB 读取期间快速／强制切换：选择器忙时禁用，同步 guard 忽略旧事件，最终只操作选中的正确参与者。
7. 延迟发送事务期间“演示推进”禁用；强制 click 也不能切换体验。异步发送／读取还带参与者与 generation 守卫，防止旧结果改写新体验界面。
8. 控制台投递后点击顶栏“回到体验”，立即读取最新状态并显示新来信；不清空未发送草稿，读取失败不会假报刷新成功。
9. 无非本地网络请求，页面 pageerror 为空。不是外部安全服务验证。

## 实际页面检查

内置浏览器打开裸预览地址，实际显示“继续已有体验”和已有小猫入口；未操作独立验收任务的样本。完整自动回归和故障注入使用仓库 Playwright 套件。

通过 `view_image` 实际查看最终 PNG：

- `/tmp/catletters-pages-evidence/p1-mobile.png`
- `/tmp/catletters-pages-evidence/p3-mobile.png`
- `/tmp/catletters-pages-evidence/postcard-mobile.png`
- `/tmp/catletters-pages-evidence/postcard-desktop.png`
- `/tmp/catletters-pages-evidence/write-failure.png`

视口为 390×844 和 1280×900。沿用已检查的 W1-F 六屏结构及 E1 工程视觉：白色阅读栏、18px 主文、低饱和绿色按钮、相同内部占位区域、详情无固定底栏遮挡。检查了正文一致性、页面层次、行距换行、首屏主按钮、输入区和长文署名／收好按钮。手机无横向溢出，全文可自然滚动，无截断。相对原 E1 的有意变化仅为直接命名、本机说明、演示推进与继续已有体验入口；未增加成长、打卡或兑换话术。

未测试真实手机键盘、Safari/WebKit、微信内置浏览器或清除数据后的恢复；清除存储可能丢失已在入口说明。正式图像和 E2 功能仍不属于本轮。
