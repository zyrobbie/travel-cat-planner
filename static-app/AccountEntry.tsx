import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import App from "./App";
import {
  AccountError,
  accountRequest,
  createAccountClient,
  type AccountSession,
} from "./account-client";
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
    revisions: number;
    reviews: number;
    calendarNodes: number;
    processedNodes: number;
    unread: number;
    offsetMs: number;
  };
  warnings: string[];
};

export default function AccountEntry() {
  const [account, setAccount] = useState<AccountSession | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState("");
  const [bundle, setBundle] = useState<unknown>(null),
    [filename, setFilename] = useState(""),
    [preview, setPreview] = useState<Preflight | null>(null);
  const [logoutPending, setLogoutPending] = useState<string | null>(null);
  const epoch = useRef(0),
    fileInput = useRef<HTMLInputElement>(null),
    channel = useRef<BroadcastChannel | null>(null),
    importKey = useRef(crypto.randomUUID());
  const clear = useCallback(() => {
    epoch.current++;
    setAccount(null);
    setBundle(null);
    setPreview(null);
    setFilename("");
    setCode("");
    setChallenge("");
    setBusy(false);
    setLoading(false);
  }, []);
  const expired = useCallback(() => {
    clear();
    setError("登录状态已变化，请重新登录。");
  }, [clear]);
  const client = useMemo(
    () => (account ? createAccountClient(account, expired) : null),
    [account, expired],
  );
  useEffect(() => () => client?.dispose(), [client]);
  useEffect(() => {
    const current = epoch.current;
    accountRequest<AccountSession>("account")
      .then((value) => {
        if (current === epoch.current) setAccount(value);
      })
      .catch((e) => {
        if (
          current === epoch.current &&
          (!(e instanceof AccountError) || e.status !== 401)
        )
          setError(e.message);
      })
      .finally(() => {
        if (current === epoch.current) setLoading(false);
      });
    const c =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("cat-letters:account-session:v1")
        : null;
    channel.current = c;
    if (c) c.onmessage = () => expired();
    return () => c?.close();
  }, [expired]);
  async function run(fn: (token: number) => Promise<void>) {
    if (busy) return;
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
      if (token === epoch.current) setBusy(false);
    }
  }
  async function refreshAccount(token: number) {
    const fresh = await accountRequest<AccountSession>(
      "account",
      undefined,
      account?.id,
    );
    if (token === epoch.current) setAccount(fresh);
  }
  async function logout(id: string) {
    // Hide all account data before waiting for the network. An uncertain logout is explicit.
    client?.dispose();
    clear();
    setLogoutPending(id);
    setBusy(true);
    try {
      await accountRequest("auth/logout", {}, id);
      setLogoutPending(null);
      channel.current?.postMessage("changed");
      setError("");
    } catch (e) {
      if (e instanceof AccountError && e.status === 401) setLogoutPending(null);
      setError(`退出结果尚未确认：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  const importUI = (
    <details className="e3-account-import">
      <summary>已有本机小猫？导入选定记录</summary>
      <p>
        请先在原本机入口打开那只小猫，点击“导出这只小猫”，再选择导出的文件。这里只导入你选择的一只小猫；未发送草稿留在原浏览器。
      </p>
      <label htmlFor="account-import">选择小猫记录文件</label>
      <input
        ref={fileInput}
        id="account-import"
        type="file"
        accept=".json,application/json"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          setBundle(null);
          setPreview(null);
          setFilename("");
          importKey.current = crypto.randomUUID();
          if (!file) return;
          void run(async (token) => {
            if (file.size > 4 * 1024 * 1024)
              throw new Error("文件超过 4 MiB，尚未上传。");
            const data: unknown = JSON.parse(await file.text());
            if (token === epoch.current) {
              setBundle(data);
              setFilename(file.name);
            }
          });
        }}
      />
      {filename && <p>{filename}</p>}
      {bundle !== null && !preview && (
        <button
          type="button"
          className={s.secondary}
          disabled={busy}
          onClick={() =>
            run(async (token) => {
              const value = await accountRequest<Preflight>(
                "legacy/preflight",
                { bundle },
                account!.id,
              );
              if (token === epoch.current) setPreview(value);
            })
          }
        >
          检查这份记录
        </button>
      )}
      {preview && (
        <section aria-label="导入确认">
          <h2>确认带回 {preview.summary.name}</h2>
          <p>
            来信 {preview.summary.letters} 封；回应 {preview.summary.responses}{" "}
            条，其中已删除 {preview.summary.deletedResponses} 条；未读{" "}
            {preview.summary.unread} 封。
          </p>
          <p>
            记录将绑定当前账号。每个账号只保留一只小猫，不能与另一只合并。原本机记录保留；草稿不会上传。
          </p>
          {preview.warnings.map((warning, index) => (
            <p className={s.note} key={index}>
              {warning}
            </p>
          ))}
          <div className="e3-confirm-actions">
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setBundle(null);
                setFilename("");
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              取消导入
            </button>
            <button
              type="button"
              className={s.primary}
              disabled={busy}
              onClick={() =>
                run(async (token) => {
                  const key = importKey.current;
                  try {
                    await accountRequest(
                      "legacy/confirm",
                      { bundle, key, bundleHash: preview.bundleHash },
                      account!.id,
                    );
                  } catch (e) {
                    if (
                      !(e instanceof AccountError) ||
                      (e.status !== 0 && e.status < 500)
                    )
                      throw e;
                    const result = await accountRequest<{ pending?: boolean }>(
                      `legacy/requests/${key}`,
                      undefined,
                      account!.id,
                    );
                    if (result.pending) throw e;
                  }
                  await refreshAccount(token);
                  if (token === epoch.current) {
                    setBundle(null);
                    setPreview(null);
                    setFilename("");
                  }
                })
              }
            >
              确认导入这只小猫
            </button>
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </details>
  );
  if (account && client)
    return (
      <App
        key={account.id + ":" + (account.cat?.id ?? "new")}
        client={client}
        adoptionIntro={importUI}
        accountControls={
          <button
            type="button"
            className={s.quiet}
            disabled={busy}
            onClick={() => logout(account.id)}
          >
            退出账号
          </button>
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
            onClick={() => logout(logoutPending)}
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
                  if (token !== epoch.current) return;
                  channel.current?.postMessage("changed");
                  setCode("");
                  await refreshAccount(token);
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
