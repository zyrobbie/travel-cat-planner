import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { editResponse, deleteResponse, saveDraft } from "./store";
import { currentText, type ResponseRecord, type Draft } from "./model";
import { versionTimeText } from "./format";
import s from "../src/app/page.module.css";

export type ResponseManagerHandle = { prepareToLeave: () => Promise<boolean> };
export default function ResponseManager({
  ref,
  participantId,
  letterTitle,
  response,
  initialDraft,
  onBusy,
  onDone,
  onCancel,
}: {
  ref?: Ref<ResponseManagerHandle>;
  participantId: string;
  letterTitle: string;
  response: ResponseRecord;
  initialDraft?: Draft;
  onBusy: (value: boolean) => void;
  onDone: (result: { message?: string; safety?: string }) => void;
  onCancel: () => Promise<void>;
}) {
  const [text, setText] = useState(
      initialDraft?.kind === "edit" ? initialDraft.text : (currentText(response) ?? ""),
    ),
    [expected] = useState(
      initialDraft?.kind === "edit" ? initialDraft.revision! : response.currentRevision,
    ),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef(false),
    key = useRef(crypto.randomUUID()),
    cancelDelete = useRef<HTMLButtonElement>(null);
  const [draftStatus, setDraftStatus] = useState(
    initialDraft?.kind === "edit" ? "有未提交的更正草稿，点“更正这条回应”可继续。" : "",
  );
  const draftWrite = useRef(0);
  const draftSavePending = useRef<Promise<unknown>>(Promise.resolve());
  const revision = response.revisions.find((item) => item.revision === response.currentRevision);
  const time = versionTimeText(revision?.at);

  useEffect(() => {
    if (confirmDelete) cancelDelete.current?.focus();
  }, [confirmDelete]);

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
  async function preserveEditDraft() {
    if (draftWrite.current === 0 && initialDraft?.kind !== "edit") return;
    await draftSavePending.current.catch(() => {});
    await saveDraft(participantId, response.letterId, "edit", text, response.id, expected);
  }
  useImperativeHandle(ref, () => ({
    prepareToLeave: async () => {
      if (confirmDelete) {
        setConfirmDelete(false);
        return false;
      }
      if (editing) await preserveEditDraft();
      return true;
    },
  }));
  return (
    <section className="e3-response-manager">
      <div className="e3-response-heading"><h2>你送出的回应</h2><span className={s.meta}>版本 {response.currentRevision}{response.currentRevision > 1 ? " · 已更正" : ""}</span></div>
      {time && <p className={s.meta}>{response.currentRevision > 1 ? "更正" : "送出"}：{time}</p>}
      <p className={s.story}>{currentText(response)}</p>
      {!editing && draftStatus && <p className={s.meta}>{draftStatus}</p>}
      {error && <p role="alert" className={s.error}>{error}</p>}
      {response.currentRevision !== expected && <p className={s.error}>另一页面已更正此回应。请取消并重新载入，避免覆盖。</p>}
      {confirmDelete ? (
        <div className="e3-delete-confirm" role="alertdialog" aria-labelledby="e3-delete-heading" aria-describedby="e3-delete-object e3-delete-warning">
          <h3 id="e3-delete-heading">删除这条回应？</h3>
          <p id="e3-delete-object" className="e3-confirm-object">「{letterTitle}」里你送出的回应 · 版本 {response.currentRevision}</p>
          <p>删除后，它不会再被用于未来的旅行来信。已经寄到你这里的旧明信片不会被改写。</p>
          <p id="e3-delete-warning">保存的原文和旧版本会清除，来源位置不再显示回应原文。删除无法撤销。</p>
          <div className="e3-confirm-actions">
            <button ref={cancelDelete} type="button" className={s.secondary} disabled={busy} onClick={() => setConfirmDelete(false)}>取消删除</button>
            <button type="button" className={s.primary} disabled={busy} onClick={() => run(() => deleteResponse(participantId, response.id, expected))}>确认删除回应</button>
          </div>
        </div>
      ) : editing ? (
        <div className="e3-edit-response">
          <label htmlFor="edit-response">更正后的回应</label>
          <p className={s.meta}>更正会保留新版本；已寄出的旅行信和它当时引用的文字不会被替换。</p>
          <textarea
            id="edit-response"
            aria-describedby="edit-response-count"
            value={text}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => {
              setText(e.target.value);
              key.current = crypto.randomUUID();
              const value = e.target.value,
                sequence = ++draftWrite.current;
              setDraftStatus("正在保存草稿…");
              draftSavePending.current = saveDraft(
                participantId, response.letterId, "edit", value, response.id, expected,
              ).then(() => {
                if (sequence === draftWrite.current) setDraftStatus("更正草稿已保存在本机，尚未提交。");
              }).catch((e) => {
                if (sequence === draftWrite.current) setDraftStatus(`草稿尚未保存：${e.message}`);
              });
            }}
          />
          <p id="edit-response-count" className={s.count}>{text.length} / 2000 字</p>
          {draftStatus && <p className={s.meta}>{draftStatus}</p>}
          <div className="e3-confirm-actions">
            <button type="button" className={s.secondary} disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await preserveEditDraft();
                setEditing(false);
              } catch (e) { setError(`更正草稿尚未保存：${(e as Error).message}`); }
              finally { setBusy(false); }
            }}>取消更正</button>
            <button type="button" className={s.primary} disabled={busy || !text.trim()} onClick={() => run(() => editResponse(participantId, response.id, expected, text, key.current))}>保存更正</button>
          </div>
          <button type="button" className={s.quiet} disabled={busy} onClick={() => setConfirmDelete(true)}>删除这条回应</button>
        </div>
      ) : (
        <div className="e3-management-actions">
          <button type="button" className={s.secondary} disabled={busy} onClick={() => setEditing(true)}>更正这条回应</button>
          <button type="button" className={s.quiet} disabled={busy} onClick={() => setConfirmDelete(true)}>删除这条回应</button>
        </div>
      )}
      {!confirmDelete && <button type="button" className={s.quiet} disabled={busy} onClick={async () => {
        if (pending.current) return;
        setBusy(true);
        onBusy(true);
        setError("");
        try {
          await preserveEditDraft();
          await onCancel();
        } catch (e) { setError(`更正草稿尚未保存：${(e as Error).message}`); }
        finally { setBusy(false); onBusy(false); }
      }}>取消管理</button>}
    </section>
  );
}
