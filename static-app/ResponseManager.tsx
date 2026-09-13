import { useRef, useState } from "react";
import { editResponse, deleteResponse, saveDraft } from "./store";
import { currentText, type ResponseRecord, type Draft } from "./model";
import s from "../src/app/page.module.css";
export default function ResponseManager({
  participantId,
  response,
  initialDraft,
  onBusy,
  onDone,
  onCancel,
}: {
  participantId: string;
  response: ResponseRecord;
  initialDraft?: Draft;
  onBusy: (value: boolean) => void;
  onDone: (result: { message?: string; safety?: string }) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(
      initialDraft?.kind === "edit"
        ? initialDraft.text
        : (currentText(response) ?? ""),
    ),
    [expected] = useState(
      initialDraft?.kind === "edit"
        ? initialDraft.revision!
        : response.currentRevision,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef(false),
    key = useRef(crypto.randomUUID());
  const [draftStatus, setDraftStatus] = useState(
    initialDraft ? "已恢复更正草稿，尚未保存为回应。" : "",
  );
  const draftWrite = useRef(0);
  async function run(fn: () => Promise<{ message?: string; safety?: string }>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await fn();
      setText("");
      onDone(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section>
      <h2>管理这条回应</h2>
      <p className={s.meta}>
        当前编辑基于版本 {expected}
        。更正或删除后，未寄出的联动需重新核验；已寄出的故事正文不会改变。
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {response.currentRevision !== expected && (
        <p className={s.error}>
          另一页面已更正此回应。请取消并重新载入，避免覆盖。
        </p>
      )}
      {confirmDelete ? (
        <>
          <h3>删除这条回应？</h3>
          <p>
            所有回应版本原文会从本机体验数据中清除。需求卡和已经寄出的故事仍保留，来源位置会显示已删除。
          </p>
          <button
            className={s.primary}
            disabled={busy}
            onClick={() =>
              run(() => deleteResponse(participantId, response.id, expected))
            }
          >
            确认删除回应
          </button>
          <button
            className={s.secondary}
            disabled={busy}
            onClick={() => setConfirmDelete(false)}
          >
            返回更正
          </button>
        </>
      ) : (
        <>
          <label htmlFor="edit-response">更正后的回应</label>
          <textarea
            id="edit-response"
            value={text}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value);
              key.current = crypto.randomUUID();
              const text = e.target.value,
                sequence = ++draftWrite.current;
              setDraftStatus("正在保存草稿…");
              saveDraft(
                participantId,
                response.letterId,
                "edit",
                text,
                response.id,
                expected,
              )
                .then(() => {
                  if (sequence === draftWrite.current)
                    setDraftStatus("更正草稿已保存在本机，尚未提交。");
                })
                .catch((e) => {
                  if (sequence === draftWrite.current)
                    setDraftStatus(`草稿尚未保存：${e.message}`);
                });
            }}
          />
          {draftStatus && <p className={s.meta}>{draftStatus}</p>}
          <button
            className={s.primary}
            disabled={busy || !text.trim()}
            onClick={() =>
              run(() =>
                editResponse(
                  participantId,
                  response.id,
                  expected,
                  text,
                  key.current,
                ),
              )
            }
          >
            保存更正
          </button>
          <button
            className={s.secondary}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            删除这条回应
          </button>
        </>
      )}
      <button
        className={s.quiet}
        disabled={busy}
        onClick={() => {
          setText("");
          saveDraft(
            participantId,
            response.letterId,
            "edit",
            "",
            response.id,
            expected,
          ).catch(() => {});
          onCancel();
        }}
      >
        取消管理
      </button>
    </section>
  );
}
