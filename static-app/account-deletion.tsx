import { useEffect, useRef, useState } from "react";
import { accountRequest } from "./account-client";
import { clearAccountLocalData } from "./account-local-data";
import {
  forgetDeletionIntent,
  type DeletionProgress,
  type DeletionTask,
} from "./account-lifecycle";
import s from "../src/app/page.module.css";
import "./account-settings.css";

export default function AccountDeletion({
  initial,
  confirmOnMount,
  onRegister,
}: {
  initial: DeletionProgress;
  confirmOnMount: boolean;
  onRegister: () => void;
}) {
  const [task, setTask] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [cleanupComplete, setCleanupComplete] = useState<boolean | null>(null);
  const mounted = useRef(true),
    started = useRef(false),
    running = useRef(false),
    controller = useRef(new AbortController());
  const taskRef = useRef(initial);
  function cleanup() {
    try {
      setCleanupComplete(
        clearAccountLocalData(initial.accountId, true).complete,
      );
    } catch {
      setCleanupComplete(false);
    }
  }
  function accept(next: DeletionTask) {
    if (
      next.accountId !== initial.accountId ||
      next.requestId !== initial.requestId
    )
      throw new Error(
        "注销进度与原请求不一致，尚未确认结果。请保留原页面并重试查询。",
      );
    if (mounted.current) {
      taskRef.current = next;
      setTask(next);
    }
  }
  async function query() {
    const result = await accountRequest<{ deletion: DeletionTask | null }>(
      "privacy/deletions/status",
      undefined,
      undefined,
      controller.current.signal,
    );
    if (!result.deletion)
      throw new Error("暂时无法确认这次注销的进度，请保留原浏览器并重试查询。");
    accept(result.deletion);
  }
  async function confirm() {
    try {
      const result = await accountRequest<{ deletion: DeletionTask }>(
        "privacy/deletions/confirm",
        { requestId: initial.requestId, confirm: true },
        initial.accountId,
        controller.current.signal,
      );
      accept(result.deletion);
    } catch {
      // Confirm may have committed and revoked the normal session. The recovery
      // cookie can still prove the exact original task without restoring login.
      try {
        await query();
      } catch {
        throw new Error(
          "注销结果尚未确认。账号内容已隐藏，请继续查询原注销进度。",
        );
      }
    }
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    cleanup();
    if (!started.current) {
      started.current = true;
      void run(confirmOnMount ? confirm : query);
    }
    return () => {
      mounted.current = false;
      controller.current.abort();
    };
  }, []);
  useEffect(() => {
    if (task.status !== "PENDING" || error) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !running.current)
        void run(query);
    }, 5000);
    return () => clearInterval(timer);
  }, [task.status, error]);
  const heading =
    task.status === "COMPLETE"
      ? "账号已注销"
      : task.status === "FAILED"
        ? "注销尚未完成"
        : task.status === "PENDING"
          ? "正在注销账号"
          : task.status === "PREPARED"
            ? "注销尚未提交"
            : "正在确认注销结果";
  return (
    <div className={`${s.shell} e3-app-shell e4-account-settings`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
      </header>
      <main>
        <h1>{heading}</h1>
        {task.status === "COMPLETE" ? (
          <p role="status">
            旧账号和小猫历史已注销。重新验证邮箱后，可以创建全新的账号，不会继承旧历史。
          </p>
        ) : (
          <p role="status">
            账号内容已隐藏。这里会继续查询同一次注销；处理中或失败都不代表注销已完成。
          </p>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {task.status === "FAILED" && (
          <p>注销处理暂未完成，账号仍暂停使用。请重试处理原任务。</p>
        )}
        {task.status === "PREPARED" && (
          <p>
            尚未查到已提交的注销决定。可以继续确认同一次注销，不会创建另一项任务。
          </p>
        )}
        {cleanupComplete === true && (
          <p>此浏览器中旧账号的草稿和请求记录已清除。</p>
        )}
        {cleanupComplete === false && (
          <>
            <p role="alert">
              部分本机草稿或请求记录暂未清除。此结果不改变云端注销进度；请检查浏览器存储设置后重试。
            </p>
            <button type="button" className={s.secondary} onClick={cleanup}>
              重试清理本机记录
            </button>
          </>
        )}
        <p className={s.note}>
          原本机入口、其他浏览器和已下载副本不会被远程删除。原本机小猫也不会自动恢复为可继续修改。
        </p>
        {task.status === "COMPLETE" ? (
          <button
            type="button"
            className={s.primary}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // A completed receipt is not a normal login. Explicitly finish its
                // recovery flow before starting another account on the same browser.
                try {
                  forgetDeletionIntent(initial.requestId);
                } catch {
                  throw new Error(
                    "注销已完成，但本机的完成标记暂未清除。请检查存储设置后重试。",
                  );
                }
                try {
                  const result = await accountRequest<{ finished: boolean }>(
                    "privacy/deletions/finish",
                    { requestId: initial.requestId },
                    undefined,
                    controller.current.signal,
                  );
                  if (!result.finished)
                    throw new Error("尚未确认注销结果页面已关闭，请重试。");
                } catch {
                  // A lost ACK is resolved by the same task's durable finished
                  // flag. No old response is allowed to clear a later cookie.
                  const result = await accountRequest<{
                    deletion: DeletionTask | null;
                  }>(
                    "privacy/deletions/status",
                    undefined,
                    undefined,
                    controller.current.signal,
                  );
                  if (
                    result.deletion?.requestId !== initial.requestId ||
                    result.deletion.accountId !== initial.accountId ||
                    result.deletion.status !== "COMPLETE" ||
                    !result.deletion.finished
                  )
                    throw new Error("注销已完成，结果页面暂未关闭，请重试。");
                }
                if (!mounted.current) return;
                onRegister();
              })
            }
          >
            重新注册
          </button>
        ) : (
          <div className="e3-confirm-actions">
            <button
              type="button"
              className={s.secondary}
              disabled={busy}
              onClick={() => void run(query)}
            >
              查询注销进度
            </button>
            {(task.status === "FAILED" || task.status === "PREPARED") && (
              <button
                type="button"
                className={s.primary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (taskRef.current.status === "PREPARED") {
                      await confirm();
                      return;
                    }
                    const result = await accountRequest<{
                      deletion: DeletionTask;
                    }>(
                      "privacy/deletions/retry",
                      { requestId: initial.requestId },
                      undefined,
                      controller.current.signal,
                    );
                    accept(result.deletion);
                  })
                }
              >
                {task.status === "PREPARED" ? "继续确认注销" : "重试注销"}
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
