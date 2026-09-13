import { useEffect, useRef, useState } from "react";
import { selectReview, deliverReview } from "./store";
import frozen from "../src/content/frozen.json";
import {
  stories,
  claimLabels,
  currentText,
  type Claim,
  type Evidence,
  type LocalState,
} from "./model";
import s from "../src/app/page.module.css";
export default function ReviewPanel({
  state,
  busy,
  perform,
}: {
  state: LocalState;
  busy: boolean;
  perform: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [storyId, setStoryId] = useState("L-RHINE"),
    [evidence, setEvidence] = useState<Partial<Record<Claim, Evidence>>>({});
  const chosen = stories.find((s) => s.id === storyId)!;
  const requests = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    setEvidence({});
    requests.current = null;
  }, [state.controlRevision]);
  const sources = Object.values(state.responses).filter(
    (r) => r.status === "ACTIVE",
  );
  const review = state.reviews
    .filter((r) => r.tripId === state.trip?.id && r.status !== "EXPIRED")
    .at(-1);
  function update(claim: Claim, patch: Partial<Evidence>) {
    setEvidence((old) => ({ ...old, [claim]: { ...old[claim]!, ...patch } }));
    requests.current = null;
  }
  return (
    <section>
      <hr className={s.divider} />
      <h2>人工核验旅行来源</h2>
      <p className={s.meta}>
        先读原来信情境和完整回应，再逐项判断。这里不做自动理解；否定、条件或适用情境不符时，不勾选支持。来源不足会选择同场景的完整普通故事。
      </p>
      <label htmlFor="linked-story">核验的故事</label>
      <select
        id="linked-story"
        value={storyId}
        disabled={busy}
        onChange={(e) => {
          setStoryId(e.target.value);
          setEvidence({});
          requests.current = null;
        }}
      >
        {stories.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </select>
      {chosen.claims.map((claim) => {
        const e = evidence[claim],
          r = e ? state.responses[e.responseId] : null,
          l = r ? state.letters.find((l) => l.id === r.letterId) : null;
        return (
          <fieldset
            key={claim}
            style={{
              margin: "20px 0",
              padding: 16,
              border: "1px solid #dce0d6",
              borderRadius: 10,
            }}
          >
            <legend>{claimLabels[claim]}</legend>
            <label htmlFor={`source-${claim}`}>实际回应来源</label>
            <select
              id={`source-${claim}`}
              disabled={busy}
              value={e?.responseId ?? ""}
              onChange={(event) => {
                const r = state.responses[event.target.value];
                setEvidence((old) => ({
                  ...old,
                  [claim]: r
                    ? {
                        claim,
                        responseId: r.id,
                        revision: r.currentRevision,
                        start: 0,
                        end: currentText(r)!.length,
                        assessment: "UNCERTAIN",
                        attested: false,
                      }
                    : undefined,
                }));
                requests.current = null;
              }}
            >
              <option value="">没有可确认的来源</option>
              {sources.map((r) => (
                <option key={r.id} value={r.id}>
                  {
                    state.letters.find((l) => l.id === r.letterId)?.snapshot
                      .title
                  }{" "}
                  · 回应版本 {r.currentRevision}
                </option>
              ))}
            </select>
            {r && l && (
              <>
                <p className={s.meta}>原来信情境</p>
                <p>{l.snapshot.body}</p>
                <p className={s.meta}>
                  完整原回应 · 版本 {e!.revision}（本次证据范围为全文）
                </p>
                <p className={s.story}>{currentText(r)}</p>
                <label htmlFor={`assessment-${claim}`}>人工判断</label>
                <select
                  id={`assessment-${claim}`}
                  value={e!.assessment}
                  disabled={busy}
                  onChange={(event) =>
                    update(claim, {
                      assessment: event.target.value as Evidence["assessment"],
                      attested: false,
                    })
                  }
                >
                  <option value="UNCERTAIN">不足以确定支持</option>
                  <option value="NEGATED">原文否定了这个含义</option>
                  <option value="CONDITION_MISMATCH">
                    条件或情境不适用于此故事
                  </option>
                  <option value="SUPPORTED">
                    原文明确定义的含义支持此故事
                  </option>
                </select>
                <label style={{ marginTop: 14 }}>
                  <input
                    style={{ width: 20, marginRight: 8 }}
                    type="checkbox"
                    checked={e!.attested}
                    disabled={busy || e!.assessment !== "SUPPORTED"}
                    onChange={(event) =>
                      update(claim, { attested: event.target.checked })
                    }
                  />
                  已核对全文、否定、条件与情境，不扩大或反转原意
                </label>
              </>
            )}
          </fieldset>
        );
      })}
      <button
        className={s.secondary}
        disabled={busy || !state.trip}
        onClick={() =>
          perform(async () => {
            const refs = chosen.claims
              .map((c) => evidence[c])
              .filter((x): x is Evidence => !!x);
            const signature = JSON.stringify([
              storyId,
              refs,
              state.controlRevision,
            ]);
            if (requests.current?.signature !== signature)
              requests.current = { signature, key: crypto.randomUUID() };
            return selectReview(
              state.participant.id,
              storyId,
              refs,
              state.controlRevision,
              requests.current.key,
            );
          })
        }
      >
        核验并选择旅行信
      </button>
      {review && (
        <div className={s.inset} style={{ marginTop: 20 }}>
          <h3>待寄选择</h3>
          <p>
            {review.kind === "LINKED" ? "联动故事" : "普通故事"} ·{" "}
            {
              frozen.items.find(
                (c) =>
                  c.id ===
                  (review.kind === "LINKED"
                    ? review.storyId
                    : review.fallbackId),
              )?.title
            }
          </p>
          <p>{review.reason}</p>
          <p className={s.meta}>
            {review.status === "NEEDS_REVIEW"
              ? "需要重新核验"
              : review.status === "DELIVERED"
                ? "已寄出"
                : "尚未寄出"}
          </p>
          <button
            className={s.primary}
            disabled={busy || review.status !== "SELECTED"}
            onClick={() =>
              perform(() =>
                deliverReview(
                  state.participant.id,
                  review.id,
                  `deliver:${review.id}`,
                ),
              )
            }
          >
            寄出已选旅行信
          </button>
        </div>
      )}
    </section>
  );
}
