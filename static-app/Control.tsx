import { useEffect, useRef, useState } from "react";
import { listParticipants, control, readState, type LocalState } from "./store";
import { selectedId } from "./local-api";
import s from "../src/app/page.module.css";
export default function LocalControl({
  onSelect,
}: {
  onSelect: (id: string) => Promise<void>;
}) {
  const [items, setItems] = useState<LocalState[]>([]),
    [id, setId] = useState(selectedId()),
    [state, setState] = useState<LocalState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [story, setStory] = useState("O-RHINE-01");
  const selection = useRef(id);
  const running = useRef(false),
    pending = useRef<{
      signature: string;
      key: string;
      revision: number;
    } | null>(null);
  async function refresh(pid = id) {
    const rows = await listParticipants();
    const next = pid ? await readState(pid) : null;
    if (selection.current !== pid) return;
    setItems(rows);
    setState(next);
  }
  async function run(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    run(() => refresh());
  }, []);
  async function action(value: string) {
    await run(async () => {
      if (!state) return;
      if (state.participant.id !== id)
        throw new Error("体验选择正在更新，请刷新后重试。");
      const signature = JSON.stringify([id, value, story]);
      if (pending.current?.signature !== signature)
        pending.current = {
          signature,
          key: crypto.randomUUID(),
          revision: state.controlRevision,
        };
      await control(
        id,
        value,
        story,
        pending.current.revision,
        pending.current.key,
      );
      await refresh();
      pending.current = null;
    });
  }
  return (
    <main>
      <h1>本机演示控制台</h1>
      <p className={s.meta}>
        这里人工推进来信与旅行。所有体验都保存在此浏览器，没有密码保护或服务端账号。
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <div className={s.inline}>
        <button disabled={busy} onClick={() => run(() => onSelect(""))}>
          建立全新体验
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await refresh();
              pending.current = null;
            })
          }
        >
          刷新演示状态
        </button>
      </div>
      <label htmlFor="local-person">选择本机体验</label>
      <select
        id="local-person"
        disabled={busy}
        value={id}
        onChange={(e) => {
          if (running.current) return;
          const next = e.target.value;
          selection.current = next;
          setId(next);
          pending.current = null;
          run(() => refresh(next));
        }}
      >
        <option value="">请选择</option>
        {items.map((p) => (
          <option key={p.participant.id} value={p.participant.id}>
            {p.participant.cat_name} · {p.participant.id.slice(0, 8)}
          </option>
        ))}
      </select>
      {state && (
        <>
          <h2>{state.participant.cat_name}</h2>
          <p>
            {state.trip ? "旅行中" : "在家"} · 已寄 {state.letters.length} 封信
          </p>
          <button
            className={s.primary}
            disabled={busy}
            onClick={() => run(() => onSelect(id))}
          >
            进入此体验
          </button>
          <div className={s.inline}>
            <button
              disabled={busy || !!state.trip}
              onClick={() => action("deliver-demand")}
            >
              投递下一需求卡
            </button>
            <button
              disabled={busy || !!state.trip}
              onClick={() => action("start-trip")}
            >
              独立开始旅行
            </button>
            <button
              disabled={busy || !state.trip}
              onClick={() => action("end-trip")}
            >
              结束旅行回家
            </button>
          </div>
          <label htmlFor="local-story">本次旅行故事</label>
          <select
            id="local-story"
            value={story}
            onChange={(e) => setStory(e.target.value)}
          >
            <option value="O-RHINE-01">山下面有一条亮亮的河</option>
            <option value="O-FIREFLY-01">好多小星星飞起来啦</option>
            <option value="O-LIGHTHOUSE-01">灯塔一闪一闪的</option>
          </select>
          <button
            disabled={busy || !state.trip}
            className={s.primary}
            onClick={() => action("deliver-postcard")}
          >
            寄出旅行明信片
          </button>
          <details>
            <summary>演示操作记录</summary>
            {state.events.map((e, i) => (
              <p className={s.meta} key={i}>
                {e.event} · {new Date(e.at).toLocaleString("zh-CN")}
              </p>
            ))}
          </details>
        </>
      )}
    </main>
  );
}
