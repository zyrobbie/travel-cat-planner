import { useEffect, useState } from "react";
import { claimLabels, type Letter } from "./model";
import type { SourceView, ViewState } from "./app-client";
import { versionTimeText } from "./format";
import s from "../src/app/page.module.css";
export default function SourceHistory({
  letter,
  state,
  isOpen,
  onOpenChange,
  onManage,
  loadSources,
}: {
  letter: Letter;
  state: ViewState;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: (source: Letter) => void;
  loadSources?: (letterId: string) => Promise<SourceView[]>;
}) {
  const [remote, setRemote] = useState<SourceView[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const linked = (
    letter.snapshot.contentId ??
    letter.storyId ??
    letter.id.slice(letter.id.lastIndexOf(":") + 1)
  ).startsWith("L-");
  useEffect(() => {
    if (!loadSources || !linked || !isOpen) return;
    let live = true;
    setRemote(null);
    setError("");
    loadSources(letter.id)
      .then((rows) => {
        if (live) setRemote(rows);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [letter.id, loadSources, isOpen, retry, state.responses, linked]);
  if (loadSources && !linked) return null;
  if (loadSources)
    return (
      <details
        open={isOpen}
        onToggle={(event) => onOpenChange(event.currentTarget.open)}
      >
        <summary>看看以前说过的话</summary>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" onClick={() => setRetry((n) => n + 1)}>
              重试
            </button>
          </p>
        ) : !remote ? (
          <p>正在读取来源…</p>
        ) : !remote.length ? (
          <p>这封信没有引用以前的回应。</p>
        ) : (
          remote.map((original, i) => {
            const response = state.responses[original.responseId];
            const ref =
              response?.status === "DELETED"
                ? {
                    ...original,
                    status: "DELETED" as const,
                    excerpt: undefined,
                  }
                : response && response.currentRevision !== original.revision
                  ? { ...original, status: "CORRECTED" as const }
                  : original;
            const source = state.letters.find((l) => l.id === ref.letterId);
            return (
              <div
                key={i}
                className={`${s.inset} e3-source-note`}
                style={{ margin: "14px 0" }}
              >
                <p className={s.meta}>
                  {ref.title} · 来源版本 {ref.revision}
                </p>
                <p className={s.meta}>{claimLabels[ref.claim]}</p>
                {ref.at && (
                  <p className={s.meta}>版本时间：{versionTimeText(ref.at)}</p>
                )}
                {ref.status === "DELETED" ? (
                  <p>这条回应已删除。</p>
                ) : (
                  <>
                    {ref.status === "CORRECTED" && (
                      <p>这条回应已更正。以下是寄出时使用的旧版本。</p>
                    )}
                    <p>那次你对{letter.snapshot.catName}说：</p>
                    <p className={s.story}>{ref.excerpt}</p>
                    {source && (
                      <button
                        type="button"
                        className={s.quiet}
                        onClick={() => onManage(source)}
                      >
                        管理这条回应
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </details>
    );
  if (!letter.sourceRefs?.length) return null;
  return (
    <details
      open={isOpen}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>看看以前说过的话</summary>
      {letter.sourceRefs.map((ref, i) => {
        const r = state.responses[ref.responseId],
          version = r?.revisions.find((v) => v.revision === ref.revision),
          source = state.letters.find((item) => item.id === r?.letterId);
        return (
          <div
            key={i}
            className={`${s.inset} e3-source-note`}
            style={{ margin: "14px 0" }}
          >
            <p className={s.meta}>
              {source?.snapshot.title ?? "一封来信"} · 来源版本 {ref.revision}
            </p>
            <p className={s.meta}>{claimLabels[ref.claim]}</p>
            {versionTimeText(version?.at) && (
              <p className={s.meta}>版本时间：{versionTimeText(version?.at)}</p>
            )}
            {!r || r.status === "DELETED" || version?.text == null ? (
              <p>这条回应已删除。</p>
            ) : (
              <>
                {r.currentRevision !== ref.revision && (
                  <p>这条回应已更正。以下是寄出时使用的旧版本。</p>
                )}
                <p>那次你对{letter.snapshot.catName}说：</p>
                <p className={s.story}>
                  {version.text.slice(ref.start, ref.end)}
                </p>
                {source && (
                  <button
                    type="button"
                    className={s.quiet}
                    onClick={() => onManage(source)}
                  >
                    管理这条回应
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}
