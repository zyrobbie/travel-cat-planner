import { claimLabels, type Letter, type LocalState } from "./model";
import { versionTimeText } from "./format";
import s from "../src/app/page.module.css";
export default function SourceHistory({
  letter,
  state,
  isOpen,
  onOpenChange,
  onManage,
}: {
  letter: Letter;
  state: LocalState;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: (source: Letter) => void;
}) {
  if (!letter.sourceRefs?.length) return null;
  return (
    <details open={isOpen} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary>看看以前说过的话</summary>
      {letter.sourceRefs.map((ref, i) => {
        const r = state.responses[ref.responseId],
          version = r?.revisions.find((v) => v.revision === ref.revision),
          source = state.letters.find((item) => item.id === r?.letterId);
        return (
          <div key={i} className={`${s.inset} e3-source-note`} style={{ margin: "14px 0" }}>
            <p className={s.meta}>
              {source?.snapshot.title ?? "一封来信"} · 来源版本 {ref.revision}
            </p>
            <p className={s.meta}>{claimLabels[ref.claim]}</p>
            {versionTimeText(version?.at) && <p className={s.meta}>版本时间：{versionTimeText(version?.at)}</p>}
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
                {source && <button type="button" className={s.quiet} onClick={() => onManage(source)}>管理这条回应</button>}
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}
