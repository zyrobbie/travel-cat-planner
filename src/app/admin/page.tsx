"use client";
import { useEffect, useState, useRef } from "react";
import { api, type AppState } from "../client-api";
import s from "../page.module.css";
type Participant = {
  id: string;
  cat_name: string | null;
  status: string;
  traveling: boolean;
};
type Timeline = AppState & {
  events: {
    id: number;
    event: string;
    created_at: string;
    simulation: boolean;
    actor: string;
  }[];
};
export default function Admin() {
  const [authorized, setAuthorized] = useState(false),
    [secret, setSecret] = useState(""),
    [participants, setParticipants] = useState<Participant[]>([]),
    [selected, setSelected] = useState(""),
    [timeline, setTimeline] = useState<Timeline | null>(null),
    [invite, setInvite] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [story, setStory] = useState("O-RHINE-01");
  const pending = useRef(false),
    operation = useRef<{ signature: string; key: string } | null>(null);
  async function refresh(id = selected) {
    setParticipants(await api("admin/participants"));
    setAuthorized(true);
    if (id) setTimeline(await api(`admin/timeline?id=${id}`));
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);
  async function run(fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function action(value: string) {
    await run(async () => {
      const signature = JSON.stringify([selected, value, story]);
      if (operation.current?.signature !== signature)
        operation.current = { signature, key: crypto.randomUUID() };
      await api("admin/action", {
        participantId: selected,
        action: value,
        contentId: story,
        key: operation.current.key,
      });
      await refresh();
      operation.current = null;
    });
  }
  return (
    <div className={`${s.shell} ${s.admin}`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信 · Admin</span>
        <a href="/">用户端</a>
      </header>
      <p className={s.note}>
        内部模拟控制台 · 所有人工推进记录 simulation=true · 不提供 linked 投递
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {!authorized ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("admin/login", { secret });
              setSecret("");
              await refresh();
            });
          }}
        >
          <h1>管理员登录</h1>
          <label htmlFor="secret">管理员密钥</label>
          <input
            type="password"
            id="secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button className={s.primary} disabled={busy}>
            登录
          </button>
        </form>
      ) : (
        <>
          <div className={s.inline}>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const p = await api("admin/participants", {});
                  setInvite(p.invite);
                  setSelected(p.id);
                  await refresh(p.id);
                })
              }
            >
              建立匿名参与者
            </button>
            <button disabled={busy} onClick={() => run(() => refresh())}>
              刷新时间线
            </button>
          </div>
          {invite && (
            <div className={s.invite}>
              <strong>一次性邀请码（24 小时有效，仅此处展示）</strong>
              <p>{invite}</p>
              <small>交给内部参与者在用户端输入；不要公开发布。</small>
            </div>
          )}
          <div className={s.columns}>
            <aside>
              <h2>参与者</h2>
              {participants.map((p) => (
                <button
                  className={s.row}
                  key={p.id}
                  onClick={() =>
                    run(async () => {
                      setSelected(p.id);
                      setInvite("");
                      await refresh(p.id);
                    })
                  }
                >
                  <strong>{p.cat_name || "尚未命名"}</strong>
                  <small>
                    {p.id.slice(0, 8)} · {p.status} ·{" "}
                    {p.traveling ? "TRIP" : "HOME"}
                  </small>
                </button>
              ))}
            </aside>
            <main>
              {timeline ? (
                <>
                  <h1>{timeline.participant.cat_name || "尚未命名"}</h1>
                  <p className={s.meta}>{selected}</p>
                  <p>
                    {timeline.participant.status} ·{" "}
                    {timeline.trip ? "TRIP" : "HOME"} · Safety:{" "}
                    {timeline.participant.safety_state}
                  </p>
                  <div className={s.inline}>
                    <button
                      disabled={
                        busy ||
                        timeline.participant.status !== "ACTIVE" ||
                        !!timeline.trip
                      }
                      onClick={() => action("deliver-demand")}
                    >
                      投递下一需求卡
                    </button>
                    <button
                      disabled={
                        busy ||
                        timeline.participant.status !== "ACTIVE" ||
                        !!timeline.trip
                      }
                      onClick={() => action("start-trip")}
                    >
                      独立开始旅行
                    </button>
                    <button
                      disabled={busy || !timeline.trip}
                      onClick={() => action("end-trip")}
                    >
                      结束旅行回家
                    </button>
                  </div>
                  <label htmlFor="story">旅行中的 ordinary</label>
                  <select
                    id="story"
                    value={story}
                    onChange={(e) => setStory(e.target.value)}
                  >
                    <option value="O-RHINE-01">山下面有一条亮亮的河</option>
                    <option value="O-FIREFLY-01">好多小星星飞起来啦</option>
                    <option value="O-LIGHTHOUSE-01">灯塔一闪一闪的</option>
                  </select>
                  <button
                    disabled={busy || !timeline.trip}
                    className={s.primary}
                    onClick={() => action("deliver-postcard")}
                  >
                    选取并投递明信片
                  </button>
                  <button
                    className={s.secondary}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const r = await api("admin/reissue-invite", {
                          participantId: selected,
                        });
                        setInvite(r.invite);
                        await refresh();
                      })
                    }
                  >
                    重发邀请码并撤销旧会话
                  </button>
                  <h2>时间线</h2>
                  {timeline.events.map((e) => (
                    <div key={e.id} className={s.timeline}>
                      {new Date(e.created_at).toLocaleString("zh-CN")}
                      <br />
                      {e.event} · {e.actor} · simulation={String(e.simulation)}
                    </div>
                  ))}
                  <h2>已投递来信</h2>
                  {timeline.letters.map((l) => (
                    <details key={l.id}>
                      <summary>{l.snapshot.title}</summary>
                      <p className={s.story}>{l.snapshot.body}</p>
                      {l.response && (
                        <>
                          <strong>真实回应（受限原文）</strong>
                          <p className={s.story}>{l.response}</p>
                        </>
                      )}
                    </details>
                  ))}
                </>
              ) : (
                <p>选择或建立一位匿名参与者。</p>
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}
