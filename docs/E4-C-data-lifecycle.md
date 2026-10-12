# E4-C 私有导出、注销与恢复

本切片继续使用 INTERNAL 和合成验证码。本地真实 PostgreSQL、HTTP、Chromium 与备份恢复演练不等于真实邮件、云端部署或真机验收。既有 Pages 本机入口不自动切换账号服务。

## 使用边界

账号设置提供个人资料导出、清除此浏览器当前账号的草稿、退出和注销。个人资料文件只用于用户主动留存；小猫迁移仍走登录与明确确认，不要求搬运文件。草稿不会上传到账号导出，普通退出不删除草稿。

导出任务私有、可查询和重试。文件发布后 24 小时内可下载，下载时重新鉴权并核对当前数据版本；来信或回应等数据改变后，旧文件可能失效，应重新生成。已经下载到用户设备的副本无法由服务端收回。

注销先显示当前邮箱、小猫与范围，用户明确确认后才执行。旧账号会话、验证码及业务任务停止，云端小猫、历史、回应版本、日历、旧 participant 数据树和绑定账本均在删除范围内。失败或结果未知不显示完成。确认前准备 HttpOnly 恢复凭证，只能查询或重试原注销任务，不能读取业务资料或接管新账号。

注销完成后，同一邮箱重新验证会获得新账号 UUID；旧任务及备份恢复均按旧 UUID 和固定关联标识处理，不能按邮箱批量删除新号。保留最小的删除证明和已绑定来源指纹，防止重新导入旧档复活已注销历史；不在删除账本中保存邮箱、猫名或正文。

单独删除回应也会先写入独立的最小删除账本。恢复旧备份时，重放删除其全部历史正文、失效待审来源及旧导出；已投递来信的固定快照保持不变。账号仍可继续使用，删除回应不等于注销。

匿名化的全局限流键不含邮件正文或验证码，最长保留 24 小时，由隐私 worker 清理；账号特定限流键随账号删除。

账号站只尝试清理当前 origin、当前旧账号的本机草稿和请求缓存；其他 origin、浏览器、已下载文件不受远程控制。旧本机 PENDING/BOUND 门闩保留，不自动解除以继续双写。

## 配置与启动

沿用 `DATABASE_URL`、`APP_MODE=INTERNAL`、合成安全/OTP 配置以及 HTTPS cookie 规则，新增：

- `E4_LIFECYCLE_DIR`：绝对私有目录，不放 `public`、Pages 发布物或 Git 内。必须与业务数据库备份独立保留；应用与两个 worker 使用同一份持久目录。
- `E4_LEDGER_SECRET`：至少 32 字符的稳定独立密钥，用于校验账本、生成来源指纹和恢复凭证。不得提交、展示给前端或在重启时重新生成。
- `E4_LIFECYCLE_BOOTSTRAP`：默认 `false`。仅确认首次新建账本时，给初始化命令临时设置 `true`；恢复旧库时必须为 `false`。

先迁移，首次受控初始化并核对后才启动账号服务：

```sh
npm run db:migrate
E4_LIFECYCLE_BOOTSTRAP=true npx tsx scripts/lifecycle.ts reconcile
npx tsx scripts/lifecycle.ts check
npm run build
npm start
```

应用、信件投递和隐私任务为独立进程，部署时都需要监督与重启：

```sh
node --import tsx scripts/cloud-worker.ts
node --import tsx scripts/lifecycle-worker.ts
```

两个 worker 都在恢复闸门未开放时拒绝处理业务。隐私 worker 不会自动创建新账本或解除恢复锁；持续失败会非零退出，必须如实检查原因，不能循环空目录初始化来掩盖故障。

## 数据库恢复顺序

1. 停止对外业务和 worker，保全**最新独立删除账本、密钥及私有目录**。不要用旧数据库快照附带的旧目录覆盖它们。
2. 用相同实例配置运行 `npx tsx scripts/lifecycle.ts restore-lock`。持久恢复锁位于业务 PostgreSQL 之外，即使恢复到相同账本水位的备份也保持关闭。
3. 恢复业务 PostgreSQL，执行所需迁移。新迁移默认关闭，不能直接放流量。
4. 保持 `E4_LIFECYCLE_BOOTSTRAP=false`，运行 `npx tsx scripts/lifecycle.ts reconcile`。核对实例身份、签名、顺序和水位，并重放全部账号删除意图及回应删除记录；任何失败都不得继续。
5. 只有 `check` 成功后才启动 worker 与应用访问，并检查被删除账号、其他账号及新注册账号的隔离。

账本缺失、损坏、落后或密钥不匹配时禁止改为空账本。该机制依赖保留最新的独立账本；若数据库和账本同时丢失或同时被错误回退，不能声称凭旧数据即可推断之后发生的删除。真正云环境的独立持久存储、权限、备份保留和恢复目标验证属于 E4-D/E6，不以本地文件适配器替代。

## 验证入口

仅限脚本明确命名的 loopback 合成测试库：

```sh
node scripts/test-e4-lifecycle.mjs --env-file /absolute/path/to/ignored.env --evidence-dir /absolute/path/to/evidence
```

脚本使用 `catletters_e4_lifecycle_test` 与 `catletters_e4_lifecycle_restore_test`，不会重置配置文件指向的个人库。备份、验证码与凭证只留在私有临时目录并清理；证据不上传这些原件。`PG_DUMP_BIN`、`PG_RESTORE_BIN` 可指定与数据库版本匹配的程序。

当前完成状态、实际命令与 PASS/FAIL 以本轮交付记录为准。本文件是实现及运行边界，不单独宣称验证已通过。

## 本地验证记录（2026-10-12 收尾）

最终生命周期测试在 10 月 8 日通过；10 月 12 日复核覆盖的 95 份源文件 SHA-256 全部一致。范围为真实 PostgreSQL/HTTP 10 项、私有目录 8 子项、隔离 Chromium 4 项、旧/新两份真实备份各 2 项恢复行为，以及 PUBLIC 拒绝服务和两个 worker 的恢复闸门。

本轮旧功能回归通过：账号 API 10 项、云信箱与内容 14 项、日历离线 4 项及在线 9 项、绑定 API 18 项及 Chromium 16 项；各专库的旧 PostgreSQL 集成用例和 PUBLIC 503 均通过。日历测试用真实 blocker PID 与 `pg_blocking_pids` 阻塞链替代硬编码 SQL 文本计数，业务断言未放宽。

原 Pages 浏览器回归 19＋12＋14 项通过；账号前端构建、Next 生产构建和类型检查通过。本机因外部依赖符号链接使用 `next build --webpack`，干净安装环境由 CI 使用默认构建。以上均为本地工程证据；PR CI、公开静态发布、真实云端、邮件及真机须分别确认，不能由本段推定。
