# E4-B2 后台日历进程

本进程处理已经持久化的云日历任务，不需要用户打开网页。当前仅允许 `APP_MODE=INTERNAL`、`SAFETY_ADAPTER=synthetic-v1`；不发送真实邮件，不提供用户可调用的 worker、人工投递、审核或快进 HTTP 接口。有限日历结束后任务进入 COMPLETE，不自动延长日历。

## 启动和停止

先配置项目已有的 `DATABASE_URL` 与内部运行环境，执行项目迁移。不要把数据库凭证写入命令历史、日志或本文。使用项目已有 Node.js 依赖：

```sh
npm run db:migrate
node --import tsx scripts/cloud-worker.ts --once
node --import tsx scripts/cloud-worker.ts
```

`--once` 最多领取并处理一个任务，输出一条 JSON（没有到期任务时为 IDLE）。返回 RETRY/FAILED 时退出码为 1；STALE 表示原租约已失效，本次没有提交日历业务。连续运行默认空闲轮询间隔为 1 秒，可用 `CLOUD_WORKER_POLL_MS` 调整为 100–60000 毫秒。空闲时不连续输出日志。

SIGTERM/SIGINT 停止新一轮领取，已经运行的事务结束后关闭数据库连接。应由实际宿主的进程管理器管理常驻运行和异常退出；本文件不声称已配置线上常驻服务。CLI 连续遇到 5 次无法记录的基础设施异常后以非零状态退出，等待运维修复/重启，避免无界快速重试。日志只含状态、匿名任务 ID 和错误类别，不记录正文、邮箱、验证码或 SQL 错误详情。

## 租约与恢复规则

1. 短事务使用 `FOR UPDATE SKIP LOCKED` 领取已到期且账号 ACTIVE 的任务，生成新 UUID token，租约 60 秒，尝试次数加一，随后提交领取事务。
2. 业务事务按 account → cat/state → job 锁定，再使用数据库时钟检查 token 和租约。与前台调用相同的日历结算函数，原子写入信、节点结果、世界状态和下一次执行时间。
3. 结算成功后检查原租约尚未到期才提交；原 token 被替换、账号被冻结、租约过期时不允许旧 worker 提交。结算中租约到期会回滚整批业务。
4. 技术异常先回滚业务，再在相同锁序下记录任务错误；仅当前有效 token 可以记录失败。重试间隔为 5、10、20、40 秒，最多 5 次尝试，最后进入 FAILED 并保留日历未处理节点。失败不会伪装成业务 SKIPPED。
5. 领取后崩溃时租约会到期，其他进程可重新领取；第五次领取后崩溃且租约到期，会明确转为 FAILED。提交成功后进程退出不重复发信：节点与任务已经一起提交，旧 token 不能再次执行。
6. 数据库完全不可用时无法记录任务错误，CLI 明确报基础设施异常；持久租约保留，连接恢复且租约到期后重新领取。任务状态不依赖进程内计时器或网页会话。

每条数据库语句最多 15 秒，锁等待最多 5 秒；事务内没有邮件、模型或其他外部网络调用。多个进程可并发领取不同任务，同一只猫的前台/后台业务由猫锁串行化。

## 检查与人工重试

使用受信任的数据库运维连接检查 FAILED；这不是产品操作按钮。排查前记录任务 ID、尝试次数和错误类别；修复根因后才重试，不删除任务、信件或节点：

```sql
SELECT id,status,next_run_at,attempts,last_error
FROM cloud_jobs WHERE status='FAILED' ORDER BY next_run_at,id;
```

以下示例使用 psql 的 `job_id` 参数，值为明确选择的一条失败任务 UUID。先锁账号、猫，再恢复失败任务；账号已冻结或任务已经不再 FAILED 时不会覆盖它：

```sql
BEGIN;
SELECT a.id FROM accounts a JOIN cloud_jobs j ON j.account_id=a.id
WHERE j.id=:'job_id'::uuid AND a.status='ACTIVE' FOR UPDATE OF a;
SELECT c.id FROM cat_profiles c JOIN cloud_jobs j ON j.cat_id=c.id
WHERE j.id=:'job_id'::uuid FOR UPDATE OF c;
UPDATE cloud_jobs j
SET status='READY',attempts=0,next_run_at=clock_timestamp(),
    lease_token=NULL,lease_until=NULL
WHERE j.id=:'job_id'::uuid AND j.status='FAILED'
  AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=j.account_id AND a.status='ACTIVE');
COMMIT;
```

该操作保留 last_error 供恢复检查；真正结算成功才清空。它不修改日历的 base/offset、已处理节点、快照或回应，也不重新创建 D0。B3 旧体验绑定与 E3 客户端云切换仍需各自实现和验收。

测试应使用独立测试库调用 `claimCloudJob` 后退出、并发 `runClaimedCloudJob`、调整测试租约或注入数据库故障来证明恢复；这些合成测试不替代实际时间观察、真实宿主常驻运行或手机验收。
