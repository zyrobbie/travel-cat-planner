import { useEffect, useRef, useState } from "react";
import {
  AccountError,
  accountRequest,
  type AccountSession,
} from "./account-client";
import { clearAccountLocalData } from "./account-local-data";
import {
  clearLifecycleRequestKey,
  lifecycleRequestKey,
  type DeletionTask,
  type ExportJob,
} from "./account-lifecycle";
import s from "../src/app/page.module.css";
import "./account-settings.css";

const statusText: Record<ExportJob["status"], string> = {
  QUEUED: "正在等待准备",
  BUILDING: "正在准备资料",
  READY: "资料已准备好",
  FAILED: "资料暂未准备好",
  EXPIRED: "文件已过期",
  REVOKED: "文件已失效",
};
export default function AccountSettings({
  account,
  onBack,
  onLogout,
  onExpired,
  onDraftsCleared,
  onDelete,
}: {
  account: AccountSession;
  onBack: () => void;
  onLogout: () => void;
  onExpired: () => void;
  onDraftsCleared: () => void;
  onDelete: (task: DeletionTask) => Promise<void>;
}) {
  const [jobs, setJobs] = useState<ExportJob[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [clearOpen, setClearOpen] = useState(false),
    [prepared, setPrepared] = useState<DeletionTask | null>(null);
  const [target, setTarget] = useState<AccountSession | null>(null);
  const mounted = useRef(true),
    running = useRef(false),
    controller = useRef(new AbortController());
  useEffect(
    () => () => {
      mounted.current = false;
      controller.current.abort();
    },
    [],
  );
  const request = <T,>(path: string, body?: unknown) =>
    accountRequest<T>(
      `privacy/${path}`,
      body,
      account.id,
      controller.current.signal,
    );
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        if (e instanceof AccountError && e.status === 401) onExpired();
        else setError((e as Error).message);
      }
    } finally {
      if (mounted.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    const result = await request<{ exports: ExportJob[] }>("exports");
    if (mounted.current) setJobs(result.exports);
  }
  async function refreshTarget() {
    const fresh = await accountRequest<AccountSession>(
      "account",
      undefined,
      account.id,
      controller.current.signal,
    );
    if (fresh.id !== account.id)
      throw new AccountError("账号状态已变化，请重新登录。", 401);
    if (mounted.current) setTarget(fresh);
    return fresh;
  }
  useEffect(() => {
    void run(async () => {
      await Promise.all([refresh(), refreshTarget()]);
    });
  }, []);
  useEffect(() => {
    if (
      !jobs.some((job) => ["QUEUED", "BUILDING"].includes(job.status)) ||
      error ||
      prepared
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !running.current)
        void run(refresh);
    }, 5000);
    return () => clearInterval(timer);
  }, [jobs, error, prepared]);
  const acceptJob = (job: ExportJob) => {
    if (mounted.current)
      setJobs((current) => [
        job,
        ...current.filter((item) => item.id !== job.id),
      ]);
  };
  async function download(job: ExportJob) {
    const response = await fetch(
      `/api/e4/privacy/exports/${encodeURIComponent(job.id)}/download`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.current.signal,
        headers: { "X-Catletters-Account": account.id },
      },
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new AccountError(
        failure.error || "文件暂不可下载，请刷新资料状态。",
        response.status,
      );
    }
    const blob = await response.blob();
    if (!mounted.current) return;
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = job.filename || "cat-letters-personal-data.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已开始下载个人资料。请在浏览器下载列表中确认保存。");
  }
  return (
    <div className={`${s.shell} e3-app-shell e4-account-settings`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
        <button
          type="button"
          className={s.quiet}
          disabled={busy}
          onClick={onBack}
        >
          返回小猫
        </button>
      </header>
      <main>
        <h1>{prepared ? "确认注销账号" : "账号设置"}</h1>
        <p className={s.note}>
          当前账号：{target?.email_normalized ?? account.email_normalized}
        </p>
        <p>
          {target
            ? `小猫：${target.cat?.name ?? "尚未领养"}`
            : "正在确认小猫资料…"}
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {prepared ? (
          <section className="e4-account-section" aria-label="注销确认">
            <p>
              注销后，这个账号的小猫、来信和已发送回应等账号记录将被删除，无法恢复。你可以先返回设置导出个人资料。
            </p>
            <p>
              注销完成后，可重新验证邮箱创建全新的账号，不会继承旧小猫和历史。
            </p>
            <p>
              此浏览器的账号草稿会尝试清除。原本机入口、其他浏览器和你已下载的副本无法在这里远程删除；原本机小猫不会自动恢复为可继续修改。
            </p>
            <div className="e3-confirm-actions">
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={() => setPrepared(null)}
              >
                暂不注销
              </button>
              <button
                type="button"
                className={s.primary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const fresh = await refreshTarget();
                    if (!mounted.current) return;
                    if (
                      fresh.cat?.id !== target?.cat?.id ||
                      fresh.cat?.name !== target?.cat?.name
                    )
                      throw new Error(
                        "小猫资料已变化，确认内容已更新。请核对后再次确认注销。",
                      );
                    await onDelete(prepared);
                  })
                }
              >
                确认注销
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="e4-account-section" aria-label="个人资料导出">
              <h2>导出个人数据</h2>
              <p>
                保存一份账号资料、小猫、来信和已发送回应的副本。未发送草稿只在原浏览器中，不包含在账号导出中。
              </p>
              <p className={s.note}>
                文件准备好后 24
                小时内可下载。导出用于个人留存，无需用它搬运小猫。
              </p>
              <div className="e3-confirm-actions">
                <button
                  type="button"
                  className={s.primary}
                  disabled={
                    busy ||
                    jobs.some((job) =>
                      ["QUEUED", "BUILDING"].includes(job.status),
                    )
                  }
                  onClick={() =>
                    void run(async () => {
                      const key = lifecycleRequestKey(account.id, "export");
                      const result = await request<{ job: ExportJob }>(
                        "exports",
                        { key },
                      );
                      if (!mounted.current) return;
                      acceptJob(result.job);
                      try {
                        clearLifecycleRequestKey(account.id, "export");
                      } catch {
                        setNotice(
                          "导出请求已创建，本机请求标记暂未清理；可继续查询这份资料。",
                        );
                      }
                    })
                  }
                >
                  生成个人资料文件
                </button>
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => void run(refresh)}
                >
                  查询导出进度
                </button>
              </div>
              <div className="e4-export-list">
                {jobs.map((job) => (
                  <article
                    className="e4-export-job"
                    key={job.id}
                    aria-label="导出任务"
                  >
                    <h3>{statusText[job.status]}</h3>
                    <p>{new Date(job.createdAt).toLocaleString("zh-CN")}</p>
                    {job.expiresAt && (
                      <p>
                        下载截止：
                        {new Date(job.expiresAt).toLocaleString("zh-CN")}
                      </p>
                    )}
                    {job.status === "READY" && (
                      <button
                        type="button"
                        className={s.secondary}
                        disabled={busy}
                        onClick={() => void run(() => download(job))}
                      >
                        下载个人资料
                      </button>
                    )}
                    {job.status === "FAILED" && (
                      <button
                        type="button"
                        className={s.secondary}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await request<{ job: ExportJob }>(
                              `exports/${encodeURIComponent(job.id)}/retry`,
                              {},
                            );
                            acceptJob(result.job);
                          })
                        }
                      >
                        重试准备资料
                      </button>
                    )}
                    {["EXPIRED", "REVOKED"].includes(job.status) && (
                      <p>可以重新生成当前资料。</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="e4-account-section" aria-label="本机草稿">
              <h2>本机草稿</h2>
              <p>未发送草稿仅保存在当前浏览器。退出账号不会自动删除草稿。</p>
              {clearOpen ? (
                <>
                  <p>
                    确定清除此浏览器中当前账号的所有未发送草稿？已发送回应不会改变，其他账号和旧本机档案不受影响。
                  </p>
                  <div className="e3-confirm-actions">
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={busy}
                      onClick={() => setClearOpen(false)}
                    >
                      保留草稿
                    </button>
                    <button
                      type="button"
                      className={s.primary}
                      disabled={busy}
                      onClick={() => {
                        const result = clearAccountLocalData(account.id);
                        onDraftsCleared();
                        if (result.complete) {
                          setClearOpen(false);
                          setNotice("此浏览器中当前账号的草稿已清除。");
                        } else
                          setError(
                            "部分本机草稿暂未清除，请检查浏览器存储设置后重试；账号记录未改变。",
                          );
                      }}
                    >
                      确认清除草稿
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => setClearOpen(true)}
                >
                  清除此浏览器草稿
                </button>
              )}
            </section>
            <section className="e4-account-section" aria-label="账号操作">
              <button
                type="button"
                className={s.secondary}
                disabled={busy}
                onClick={onLogout}
              >
                退出账号
              </button>
              <button
                type="button"
                className={s.quiet}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const key = lifecycleRequestKey(
                      account.id,
                      "delete-prepare",
                    );
                    const [result] = await Promise.all([
                      request<{ deletion: DeletionTask }>("deletions/prepare", {
                        key,
                      }),
                      refreshTarget(),
                    ]);
                    if (
                      result.deletion.accountId !== account.id ||
                      result.deletion.status !== "PREPARED"
                    )
                      throw new Error("账号状态已变化，请重新查询注销进度。");
                    if (mounted.current) setPrepared(result.deletion);
                  })
                }
              >
                注销账号
              </button>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
