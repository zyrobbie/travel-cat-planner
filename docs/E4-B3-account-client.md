# E4-B3 账号界面与当前小猫直接绑定

本阶段仍为 INTERNAL 合成测试。当前实现没有部署真实云账号服务，也没有发送真实邮件；合成验证码、隔离 PostgreSQL 和本机浏览器验证不能代替云端发布或用户验收。真实邮件、服务主机和对外开放仍属于后续 E4-D。

## 构建与入口

- `npm run account:build` 使用 Vite 构建 `static-app/account-app`，生成 `public/account-app/index.html` 与已批准的 WebP 资源。
- 同源 Next 服务提供 `/account-app/`（入口映射由 Next 配置管理）。会话通过 HttpOnly cookie 发送到 `/api/e4`，不把 token、验证码或密钥放进界面或前端构建。
- `npm run pages:build` 继续生成原本机体验，不自动登录、上传或切换云模式。没有显式配置账号地址时不展示保存到账号入口。
- 两种入口复用 `App`、`ResponseManager`、`SourceHistory`、`Scenes` 和原 CSS；`AppClient` 注入数据接口，云客户端不制造本机日历、不在失败时回退本机。

构建配置只有公开地址，没有账号密钥：

- 本机入口通过 `VITE_ACCOUNT_APP_URL` 指向受信账号页面的完整地址。必须是 HTTPS，或用于本机测试的 loopback HTTP；拒绝用户名、密码、查询参数和片段。不从页面 URL 参数接受替代服务地址。
- 账号入口通过 `VITE_LEGACY_SOURCE_ORIGINS` 明确列出允许交接的来源 origin，以逗号分隔；未设置时只接受账号页面自己的 origin。跨源交接须同时配置两侧。
- 配置地址只决定是否提供入口，不证明该地址已经部署了可用服务。生产构建不得指向临时测试地址，也不得把内部合成验证描述为真实邮箱登录。

## 真实数据边界

首页通过服务端 state、来信摘要、回应摘要投影显示状态，只提示“有信”，不预读未读配图和正文。用户打开来信才调用 read；成功后直接显示这次提交返回的快照，不依赖第二次 GET 才完成阅读。已读草稿恢复调用只读 detail，保持“无未读时恢复草稿、有未读时先回首页”的规则。来源历史使用服务端 sources，编辑和删除通过版本检查与幂等 API 提交。

状态投影的三个 stateRevision 必须相同，跨并发修订时最多重新读取三次。旧刷新不能覆盖随后明确打开的信件。网络中断的提交使用原请求 key 查询结果；未确认时显示错误，重试保留相同 key。

## 草稿与账号切换

账号模式的新草稿仅存在当前 origin 的本机存储，键包含 accountId、物理 catId、letterId 与 reply/edit 类型。原匿名体验草稿继续留在原浏览器原 origin 的 IndexedDB，绑定时不上传，也不会自动出现在另一域名。失效版本草稿不覆盖当前回应，损坏草稿保留原记录并提示，不阻止阅读账号来信。服务端提交成功后，本机清理失败会单独提示；提交结果仍按成功处理。

退出立即卸载可见账号界面，终止在途请求。退出网络结果不明确时只提供重试退出，不伪称会话已注销。跨页登录变动通过 BroadcastChannel 清理可见状态；每次已登录请求同时发送 `X-Catletters-Account`，服务端核对会话账号。401 返回登录页，没有本机后备数据。

## 无文件直接绑定

用户在原浏览器打开当前猫，主动进入账号保存流程，在新窗口登录并确认绑定，然后在账号入口继续。无需下载、选择或上传 JSON 文件。这里沿用的 `legacy` API 名称是内部协议，不是用户操作步骤。

同 origin 和跨 origin 均使用用户点击时同步打开的受信 popup。片段只携带随机交接 nonce 与来源 origin，不携带小猫正文、验证码或会话 token；账号页接收后清除片段。消息双向核对 origin、窗口引用、nonce、请求 ID 和有效期，所有账号 HTTP 请求仍由账号页同源发起，不新增 CORS 或服务端档案中转。

新域登录本身不能读取旧域 IndexedDB。登录后由仍打开的原页只读当前 selectedId，对共享白名单投影生成内存中的记录；原始 bundle 不另存一份。草稿、事件、请求缓存以及派生回应副本均不传。账号已经有猫时不覆盖、不追加、不合并；已提交绑定的结果恢复按原请求处理。

账号页预检后展示猫名与来信、回应、删除、未读计数，用户明确确认才提交绑定。预检不占用账号名额。服务端通过账号锁、源档唯一约束以及同 key/hash 的幂等结果处理领养竞争、重复确认和复制旧档；损坏或无法证明内容版本的记录停止绑定，不改写原档。

## 本机冻结、取消和恢复

IndexedDB 升至 version 4，仅新增 `accountBindings`，现有 schema 3 原行不重写。旧连接在 versionchange 关闭；旧 version 3 代码不能重新打开 version 4 写入。单猫读取使用 `get(id)`，不枚举其他猫。

确认时在一个包含 `participants` 和 `accountBindings` 的事务里，重新读取当前猫，比较完整白名单投影与预检摘要，再记录 PENDING。统一业务写入在同一事务检查绑定状态：PENDING 或 BOUND 都拒绝修改原猫并保留原记录与草稿。网络请求不放在 IDB 事务里，暂停记录只存 sourceId、受信 targetUrl、accountId、key、bundleHash 和 phase。

确认超时、窗口关闭或刷新不等于失败，也不会自动恢复本机写入。恢复须回到原页面，以原账号、原 key/hash 查询结果；`pending` 仅表示尚未查到已提交结果。成功回执校验后标记 BOUND，从账号继续。更换账号、当前猫或配置目标不能沿用旧预检。

用户取消时，服务端取消屏障与确认共用账号锁：取消先提交则原 key 的迟到确认被拒；确认先提交则取消返回原成功回执。只有明确且匹配的取消回执才允许移除本机 PENDING；BOUND 不解除。取消成功但本机 ACK 丢失的重试只确认该会话原操作，不删除新 PENDING 或 BOUND。结果不明时保留原档与暂停状态，并提供重试。

## E4-C 删除与恢复清单

后续账号删除和恢复流程必须同时考虑 `legacy_bindings`、`legacy_binding_requests` 以及新增 `legacy_binding_cancellations`。取消账本以 accountId/key 归属，只存 hash 和时间，不存正文；账号仍有效时不能随意清除取消屏障，使旧 key 再次可执行。账号销毁清理须与账号冻结、会话失效及迟到请求拒绝保持一致，不能用邮箱作为新旧账号的清理身份。

本机 `accountBindings` 的 PENDING/BOUND、原匿名记录与草稿、账号模式草稿需在 E4-C 明确处理范围和用户选择。服务端无法远程删除另一 origin 或另一浏览器的 IndexedDB；不得把云端删除完成写成本机各份副本均已删除，也不得自动解除 BOUND 后恢复旧档继续同步。

## 检查范围

`node --import tsx --test tests/e4/account-client.test.ts` 验证客户端边界；`tests/e4/account-client.spec.ts` 和 `tests/e4/binding-storage.spec.ts` 覆盖真实浏览器交接、恢复及存储竞争，`tests/e4/legacy-binding.test.ts` 覆盖真实 PostgreSQL/HTTP 绑定与取消屏障。具体命令、实际结果和仍未验证的范围以本轮统一测试报告为准，此文不预记未结束的回归为通过。

两个 localhost 端口可验证跨 origin 交接，但不等同不同站点部署、微信/Chrome 真机或真实邮件验证。原 Pages 回归、账号接口与浏览器测试、CI、线上部署和用户验收分别记录。

2026-10-08 本地最终验证：客户端单元 6/6、真实 PostgreSQL/HTTP/worker 绑定与取消 12/12、旧 PG 集成 1/1、Chromium 16/16、PUBLIC 503 守卫及两次迁移通过；原 Pages 19 + E2A 12 + E2B 14 全部通过。390/1280 确认页已目检，正常流程没有工程迁移提示或手动文件入口。隔离工作树的外部 node_modules 链接被本机 Turbopack 拒绝，Webpack 生产构建及类型检查通过；默认构建另由干净安装的 CI 验证，不能将本机默认构建记为通过。
