import { claimLabels, type Letter, type LocalState } from "./model";
import s from "../src/app/page.module.css";
export default function SourceHistory({
  letter,
  state,
}: {
  letter: Letter;
  state: LocalState;
}) {
  if (!letter.sourceRefs?.length) return null;
  return (
    <details>
      <summary>看看以前的来信</summary>
      {letter.sourceRefs.map((ref, i) => {
        const r = state.responses[ref.responseId],
          version = r?.revisions.find((v) => v.revision === ref.revision);
        return (
          <div key={i} className={s.inset} style={{ margin: "14px 0" }}>
            <p className={s.meta}>
              {claimLabels[ref.claim]} · 来源版本 {ref.revision}
            </p>
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
              </>
            )}
          </div>
        );
      })}
    </details>
  );
}
