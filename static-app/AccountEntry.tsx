import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App";
import AccountSettings from "./account-settings";
import AccountDeletion from "./account-deletion";
import {
  readDeletionIntent,
  forgetDeletionIntent,
  rememberDeletionIntent,
  type AccountMessage,
  type DeletionProgress,
  type DeletionTask,
} from "./account-lifecycle";
import {
  AccountError,
  accountRequest,
  createAccountClient,
  type AccountSession,
} from "./account-client";
import { receiveBindingBridge } from "./binding-bridge";
import {
  parseLegacyTransfer,
  type LegacyTransfer,
} from "../src/shared/legacy-transfer";
import type {
  BindingGate,
  BindingReceipt,
  BindingCancellation,
} from "./binding-storage";
import s from "../src/app/page.module.css";

type Preflight = {
  bundleHash: string;
  summary: {
    logicalCatId: string;
    name: string;
    appearanceId: string;
    letters: number;
    responses: number;
    deletedResponses: number;
    unread: number;
  };
  warnings: string[];
};
type BindingResult = BindingReceipt | BindingCancellation | { pending: true };
type SourceRecord = { bundle: LegacyTransfer; gate: BindingGate | null };
const maskedEmail = (email: string) => email.replace(/^(.).*(@.*)$/, "$1***$2");

export default function AccountEntry() {
  const [launch] = useState(() => {
    try {
      return { bridge: receiveBindingBridge(), error: "" };
    } catch (e) {
      return { bridge: null, error: (e as Error).message };
    }
  });
  const [account, setAccount] = useState<AccountSession | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState("");
  const [bundle, setBundle] = useState<LegacyTransfer | null>(null),
    [preview, setPreview] = useState<Preflight | null>(null),
    [gate, setGate] = useState<BindingGate | null>(null);
  const [bindingDone, setBindingDone] = useState(false),
    [bindingCancelled, setBindingCancelled] = useState(false),
    [connecting, setConnecting] = useState(false);
  const [logoutPending, setLogoutPending] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [viewRevision, setViewRevision] = useState(0);
  const [deletion, setDeletion] = useState<{
    task: DeletionProgress;
    confirmOnMount: boolean;
  } | null>(null);
  const currentAccount = useRef<AccountSession | null>(null),
    currentDeletion = useRef(deletion),
    currentClient = useRef<ReturnType<typeof createAccountClient> | null>(null);
  currentAccount.current = account;
  currentDeletion.current = deletion;
  const epoch = useRef(0),
    channel = useRef<BroadcastChannel | null>(null),
    importKey = useRef(crypto.randomUUID()),
    attemptedAccount = useRef("");
  const running = useRef(false);
  const currentGate = useRef<BindingGate | null>(null),
    currentBundle = useRef<LegacyTransfer | null>(null);
  const clear = useCallback(() => {
    epoch.current++;
    currentClient.current?.dispose();
    currentAccount.current = null;
    attemptedAccount.current = "";
    running.current = false;
    currentGate.current = null;
    currentBundle.current = null;
    setAccount(null);
    setBundle(null);
    setPreview(null);
    setGate(null);
    setCode("");
    setChallenge("");
    setBusy(false);
    setLoading(false);
    setConnecting(false);
    setSettingsOpen(false);
    setLogoutPending(null);
  }, []);
  const expired = useCallback(() => {
    clear();
    setError("登录状态已变化，请重新登录。保存中的本机记录仍然保留。");
  }, [clear]);
  const client = useMemo(() => {
    const token = epoch.current;
    return account
      ? createAccountClient(account, () => {
          if (
            token === epoch.current &&
            currentAccount.current?.id === account.id
          )
            expired();
        })
      : null;
  }, [account, expired, viewRevision]);
  currentClient.current = client;
  useEffect(() => () => client?.dispose(), [client]);
  useEffect(() => () => launch.bridge?.dispose(), [launch]);
  useEffect(() => {
    const token = epoch.current;
    const intent = readDeletionIntent();
    Promise.allSettled([
      accountRequest<AccountSession>("account"),
      accountRequest<{ deletion: DeletionTask | null }>(
        "privacy/deletions/status",
      ),
    ])
      .then(([session, recovery]) => {
        if (token !== epoch.current) return;
        const active = session.status === "fulfilled" ? session.value : null;
        const receipt =
          recovery.status === "fulfilled" ? recovery.value.deletion : null;
        // A recovery cookie belongs to one old identity. It never takes over a
        // different account that subsequently logged in on this browser.
        const sameIdentity = (id: string) => !active || active.id === id;
        const finished =
          receipt?.status === "COMPLETE" && receipt.finished === true;
        if (
          finished &&
          intent?.accountId === receipt.accountId &&
          intent.requestId === receipt.requestId
        ) {
          // The server's completed recovery decision wins over stale local metadata.
          try {
            forgetDeletionIntent(receipt.requestId);
          } catch {
            /* No account data is being accessed or deleted. */
          }
        }
        if (
          receipt &&
          !finished &&
          sameIdentity(receipt.accountId) &&
          (receipt.status !== "PREPARED" ||
            (intent?.accountId === receipt.accountId &&
              intent.requestId === receipt.requestId))
        ) {
          setDeletion({ task: receipt, confirmOnMount: false });
          return;
        }
        if (intent && sameIdentity(intent.accountId) && !receipt) {
          setDeletion({ task: intent, confirmOnMount: false });
          return;
        }
        if (active) setAccount(active);
        else if (
          session.status === "rejected" &&
          (!(session.reason instanceof AccountError) ||
            session.reason.status !== 401)
        )
          setError(session.reason.message);
        else if (recovery.status === "rejected")
          setError(
            "暂时无法查询注销进度。若刚确认过注销，请保留原浏览器并刷新重试。",
          );
      })
      .finally(() => {
        if (token === epoch.current) setLoading(false);
      });
    const c =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("cat-letters:account-session:v1")
        : null;
    channel.current = c;
    if (c)
      c.onmessage = (event: MessageEvent<AccountMessage | string>) => {
        const message = event.data;
        if (message === "changed") {
          expired();
          return;
        }
        if (!message || typeof message !== "object") return;
        const id = currentAccount.current?.id;
        if (message.type === "SESSION_CHANGED") {
          if (
            !id ||
            id !== message.accountId ||
            (currentDeletion.current &&
              currentDeletion.current.task.accountId !== message.accountId)
          ) {
            setDeletion(null);
            expired();
          }
        } else if (
          message.type === "ACCOUNT_LOGOUT" &&
          id === message.accountId
        )
          expired();
        else if (
          message.type === "DRAFTS_CLEARED" &&
          id === message.accountId
        ) {
          currentClient.current?.dispose();
          setViewRevision((value) => value + 1);
        } else if (
          message.type === "ACCOUNT_DELETING" &&
          id === message.accountId &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            message.requestId,
          )
        ) {
          clear();
          setDeletion({
            task: {
              requestId: message.requestId,
              accountId: message.accountId,
              status: "UNKNOWN",
              requestedAt: null,
              completedAt: null,
              error: null,
              finished: false,
            },
            confirmOnMount: false,
          });
        }
      };
    return () => c?.close();
  }, [clear, expired]);

  function alive(token: number) {
    if (token !== epoch.current)
      throw new Error("账号状态已变化，请重新开始。");
  }
  async function run(fn: (token: number) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const token = epoch.current;
    try {
      await fn(token);
    } catch (e) {
      if (token === epoch.current) {
        if (e instanceof AccountError && e.status === 401) expired();
        else setError((e as Error).message);
      }
    } finally {
      if (token === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function refreshAccount(token: number) {
    const fresh = await accountRequest<AccountSession>(
      "account",
      undefined,
      account?.id,
    );
    alive(token);
    setAccount(fresh);
    return fresh;
  }
  async function logout(id: string) {
    client?.dispose();
    clear();
    const token = epoch.current;
    setLogoutPending(id);
    setBusy(true);
    try {
      await accountRequest("auth/logout", {}, id);
      if (token !== epoch.current) return;
      setLogoutPending(null);
      channel.current?.postMessage({
        type: "ACCOUNT_LOGOUT",
        accountId: id,
      } satisfies AccountMessage);
      setError("");
    } catch (e) {
      if (token !== epoch.current) return;
      if (e instanceof AccountError && e.status === 401) setLogoutPending(null);
      setError(`退出结果尚未确认：${(e as Error).message}`);
    } finally {
      if (token === epoch.current) setBusy(false);
    }
  }

  async function beginDeletion(task: DeletionTask) {
    if (
      task.accountId !== currentAccount.current?.id ||
      task.status !== "PREPARED"
    )
      throw new Error("账号状态已变化，请重新打开账号设置。");
    // Save only the task identity before sending any irreversible decision. If
    // browser storage fails, leave the confirmation screen intact and stop.
    try {
      rememberDeletionIntent(task);
    } catch {
      throw new Error(
        "浏览器暂时无法保留注销请求，请检查存储设置后再确认。尚未提交注销。",
      );
    }
    clear();
    setDeletion({ task: { ...task, status: "UNKNOWN" }, confirmOnMount: true });
    channel.current?.postMessage({
      type: "ACCOUNT_DELETING",
      accountId: task.accountId,
      requestId: task.requestId,
    } satisfies AccountMessage);
  }

  async function acceptResult(
    result: BindingResult,
    token: number,
    pending: BindingGate,
  ): Promise<boolean> {
    alive(token);
    if ("pending" in result) return false;
    if ("cancelled" in result) {
      if (
        result.cancelled !== true ||
        result.key !== pending.key ||
        result.bundleHash !== pending.bundleHash
      )
        throw new Error("取消回执与原请求不一致，请保留原记录并重试。");
      await launch.bridge!.request("RELEASE", { receipt: result });
      alive(token);
      currentGate.current = null;
      currentBundle.current = null;
      setGate(null);
      setBundle(null);
      setPreview(null);
      setBindingCancelled(true);
      window.name = "";
      return true;
    }
    if (
      result.logicalCatId !== pending.sourceId ||
      result.bundleHash !== pending.bundleHash
    )
      throw new Error("保存回执与原小猫不一致，请保留原记录并重试。");
    await launch.bridge!.request("COMPLETE", { receipt: result });
    alive(token);
    currentBundle.current = null;
    setBundle(null);
    setPreview(null);
    // Keep the handoff screen mounted until the refreshed account owns the new
    // client. Otherwise a recovered cat can mount App with a client that this
    // refresh immediately disposes, aborting App's first state load.
    await refreshAccount(token);
    setBindingDone(true);
    window.name = "";
    return true;
  }

  async function connectSource(token: number) {
    if (!launch.bridge || !account) return;
    setConnecting(true);
    try {
      const source = await launch.bridge.request<SourceRecord>("READ", {
        accountId: account.id,
        hasCat: !!account.cat,
      });
      alive(token);
      const parsed = parseLegacyTransfer(source.bundle);
      currentBundle.current = parsed;
      setBundle(parsed);
      currentGate.current = source.gate;
      setGate(source.gate);
      if (source.gate) {
        if (
          source.gate.accountId !== account.id ||
          source.gate.sourceId !== parsed.sourceExperienceId
        )
          throw new Error("待确认记录属于其他账号，请返回原页面重试。");
        importKey.current = source.gate.key;
        // A committed handoff must be recovered before the usual 'account has cat' guard.
        const result = await accountRequest<BindingResult>(
          `legacy/requests/${source.gate.key}`,
          undefined,
          account.id,
        );
        alive(token);
        if (await acceptResult(result, token, source.gate)) return;
      }
      if (account.cat)
        throw new Error(
          "这个账号已经有一只小猫，不能覆盖或合并。请使用原账号确认待保存记录，或取消保存。",
        );
      const value = await accountRequest<Preflight>(
        "legacy/preflight",
        { bundle: parsed },
        account.id,
      );
      alive(token);
      if (
        value.summary.logicalCatId !== parsed.sourceExperienceId ||
        !/^[a-f0-9]{64}$/.test(value.bundleHash) ||
        (source.gate && source.gate.bundleHash !== value.bundleHash)
      )
        throw new Error("预检结果与当前小猫不一致，尚未确认保存。");
      setPreview(value);
    } finally {
      if (token === epoch.current) setConnecting(false);
    }
  }
  useEffect(() => {
    if (
      !launch.bridge ||
      !account ||
      busy ||
      bindingDone ||
      bindingCancelled ||
      attemptedAccount.current === account.id
    )
      return;
    attemptedAccount.current = account.id;
    void run(connectSource);
    // One automatic read per authenticated session; retries are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, launch.bridge, busy, bindingDone, bindingCancelled]);

  async function confirmBinding(token: number) {
    if (!account || !launch.bridge) return;
    let pending = currentGate.current;
    if (pending) {
      const existing = await accountRequest<BindingResult>(
        `legacy/requests/${pending.key}`,
        undefined,
        account.id,
      );
      alive(token);
      if (await acceptResult(existing, token, pending)) return;
    }
    if (!currentBundle.current || !preview) {
      await connectSource(token);
      return;
    }
    // Remember the exact tuple before requesting the durable freeze: a lost ACK must not create a new key.
    pending = pending ?? {
      sourceId: currentBundle.current.sourceExperienceId,
      accountId: account.id,
      key: importKey.current,
      bundleHash: preview.bundleHash,
      phase: "PENDING",
      targetUrl: location.origin + location.pathname,
    };
    currentGate.current = pending;
    setGate(pending);
    const frozen = await launch.bridge.request<BindingGate>("FREEZE", {
      accountId: account.id,
      key: pending.key,
      bundleHash: pending.bundleHash,
    });
    alive(token);
    if (
      frozen.sourceId !== pending.sourceId ||
      frozen.accountId !== account.id ||
      frozen.key !== pending.key ||
      frozen.bundleHash !== pending.bundleHash ||
      frozen.phase !== "PENDING"
    )
      throw new Error("本机暂停回执不一致，尚未提交保存。");
    currentGate.current = frozen;
    setGate(frozen);
    const result = await accountRequest<BindingResult>(
      "legacy/confirm",
      {
        bundle: currentBundle.current,
        key: frozen.key,
        bundleHash: frozen.bundleHash,
      },
      account.id,
    );
    alive(token);
    if (!(await acceptResult(result, token, frozen)))
      throw new Error("保存结果尚未确认，请重试确认结果。");
  }
  async function cancelBinding(token: number) {
    if (!launch.bridge || !account) return;
    const pending = currentGate.current;
    if (pending) {
      const result = await accountRequest<BindingResult>(
        "legacy/cancel",
        { key: pending.key, bundleHash: pending.bundleHash },
        account.id,
      );
      alive(token);
      if (!(await acceptResult(result, token, pending)))
        throw new Error("取消结果尚未确认，请重试。");
      if (!("cancelled" in result)) return;
    } else {
      await launch.bridge.request("CLOSE", {});
      alive(token);
      currentBundle.current = null;
      setBundle(null);
      setPreview(null);
      setBindingCancelled(true);
      window.name = "";
    }
    window.close();
  }

  const logoutButton = account && (
    <button
      type="button"
      className={s.quiet}
      disabled={busy}
      onClick={() => void logout(account.id)}
    >
      退出账号
    </button>
  );
  const renderEpoch = epoch.current;
  if (deletion)
    return (
      <AccountDeletion
        key={deletion.task.requestId}
        initial={deletion.task}
        confirmOnMount={deletion.confirmOnMount}
        onRegister={() => {
          if (renderEpoch !== epoch.current) return;
          clear();
          setDeletion(null);
          setEmail("");
          setError("");
          setBindingDone(true);
        }}
      />
    );
  if (launch.error)
    return (
      <div className={`${s.shell} e3-app-shell`}>
        <header className={s.header}>
          <span className={s.brand}>有猫来信</span>
        </header>
        <main>
          <h1>请回到原本机页面</h1>
          <p role="alert">{launch.error}</p>
        </main>
      </div>
    );
  if (account && launch.bridge && !bindingDone)
    return (
      <div className={`${s.shell} e3-app-shell`}>
        <header className={s.header}>
          <span className={s.brand}>有猫来信</span>
          {logoutButton}
        </header>
        <main>
          <h1>
            {bindingCancelled
              ? "已取消保存"
              : gate
                ? "确认保存结果"
                : preview
                  ? `确认保存 ${preview.summary.name}`
                  : "连接原本机小猫"}
          </h1>
          <p>当前账号：{maskedEmail(account.email_normalized)}</p>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          {connecting && <p role="status">正在读取你选定的小猫并检查记录…</p>}
          {preview && (
            <section aria-label="保存确认">
              <p>
                来信 {preview.summary.letters} 封；回应{" "}
                {preview.summary.responses} 条，其中已删除{" "}
                {preview.summary.deletedResponses} 条；未读{" "}
                {preview.summary.unread} 封。
              </p>
              <p>
                确认后，这只小猫将保存到当前账号。原本机记录保留；未发送草稿仍留在原浏览器。
              </p>
            </section>
          )}
          {gate && (
            <p role="status">
              原请求已保留，结果确认前本机暂停修改。重试不会重复创建小猫。
            </p>
          )}
          {!bindingCancelled && (
            <div className="e3-confirm-actions">
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() => void run(cancelBinding)}
              >
                {gate ? "取消保存" : "暂不保存"}
              </button>
              {preview || gate ? (
                <button
                  type="button"
                  className={s.primary}
                  disabled={busy}
                  onClick={() => void run(confirmBinding)}
                >
                  {gate ? "重试确认保存结果" : "确认保存这只小猫"}
                </button>
              ) : (
                <button
                  type="button"
                  className={s.primary}
                  disabled={busy}
                  onClick={() => void run(connectSource)}
                >
                  重新连接本机小猫
                </button>
              )}
            </div>
          )}
          {bindingCancelled && <p>原本机记录未改写，请回到原页面继续。</p>}
          {account.cat && !gate && (
            <button
              type="button"
              className={s.quiet}
              disabled={busy}
              onClick={async () => {
                await run(async (token) => {
                  await launch.bridge!.request("CLOSE", {});
                  alive(token);
                  setBindingDone(true);
                  window.name = "";
                });
              }}
            >
              进入已有小猫
            </button>
          )}
        </main>
      </div>
    );
  if (account && client && settingsOpen)
    return (
      <AccountSettings
        account={account}
        onBack={() => setSettingsOpen(false)}
        onLogout={() => void logout(account.id)}
        onExpired={() => {
          if (
            renderEpoch === epoch.current &&
            currentAccount.current?.id === account.id
          )
            expired();
        }}
        onDelete={beginDeletion}
        onDraftsCleared={() => {
          setViewRevision((value) => value + 1);
          channel.current?.postMessage({
            type: "DRAFTS_CLEARED",
            accountId: account.id,
          } satisfies AccountMessage);
        }}
      />
    );
  if (account && client)
    return (
      <App
        key={account.id + ":" + (account.cat?.id ?? "new") + ":" + viewRevision}
        client={client}
        accountControls={
          <span className="e4-account-controls">
            <button
              type="button"
              className={s.quiet}
              onClick={() => setSettingsOpen(true)}
            >
              账号设置
            </button>
            {logoutButton}
          </span>
        }
      />
    );
  return (
    <div className={`${s.shell} e3-app-shell`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
      </header>
      <main>
        <h1>账号内部测试</h1>
        <p className={s.note}>
          此入口连接账号服务。当前使用合成验证码测试，尚未提供真实邮件登录。原本机入口和记录继续保留。
        </p>
        {launch.bridge && (
          <p>登录后，将自动检查你在原页面选定的小猫，再由你确认是否保存。</p>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {loading ? (
          <p>正在确认登录状态…</p>
        ) : logoutPending ? (
          <button
            type="button"
            className={s.primary}
            disabled={busy}
            onClick={() => void logout(logoutPending)}
          >
            重试退出账号
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async (token) => {
                if (!challenge) {
                  const result = await accountRequest<{ challengeId: string }>(
                    "auth/request-code",
                    { email },
                  );
                  if (token === epoch.current) setChallenge(result.challengeId);
                } else {
                  await accountRequest("auth/verify-code", {
                    email,
                    challengeId: challenge,
                    code,
                  });
                  alive(token);
                  setCode("");
                  const fresh = await refreshAccount(token);
                  channel.current?.postMessage({
                    type: "SESSION_CHANGED",
                    accountId: fresh.id,
                  } satisfies AccountMessage);
                }
              });
            }}
          >
            <label htmlFor="account-email">邮箱</label>
            <input
              id="account-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              disabled={busy || !!challenge}
              onChange={(event) => setEmail(event.target.value)}
            />
            {challenge && (
              <>
                <label htmlFor="account-code">验证码</label>
                <input
                  id="account-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  disabled={busy}
                  onChange={(event) => setCode(event.target.value)}
                />
                <p className={s.note}>
                  输入本次测试验证码。此页面不会显示或读取验证码。
                </p>
              </>
            )}
            <button className={s.primary} disabled={busy}>
              {challenge ? "登录" : "获取验证码"}
            </button>
            {challenge && (
              <button
                type="button"
                className={s.quiet}
                disabled={busy}
                onClick={() => {
                  setChallenge("");
                  setCode("");
                }}
              >
                重新获取 / 更换邮箱
              </button>
            )}
          </form>
        )}
      </main>
    </div>
  );
}
