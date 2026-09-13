"use client";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AppState, type Letter } from "./client-api";
import s from "./page.module.css";
const scenes: Record<string, string> = {
  RHINE: "德国 · 莱茵河谷",
  FIREFLY: "日本 · 辰野",
  LIGHTHOUSE: "苏格兰 · 天空岛",
};
export default function Home() {
  const [state, setState] = useState<AppState | null>(null),
    [loaded, setLoaded] = useState(false),
    [loadFailed, setLoadFailed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState(""),
    [name, setName] = useState("小咪"),
    [screen, setScreen] = useState<"home" | "inbox" | "letter" | "success">(
      "home",
    ),
    [letterId, setLetterId] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [filter, setFilter] = useState("全部"),
    [safety, setSafety] = useState(false);
  const key = useRef(""),
    pending = useRef(false);
  async function reload() {
    const data = await api("state");
    setState(data);
    return data as AppState;
  }
  async function initialLoad() {
    setError("");
    setLoadFailed(false);
    try {
      await reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setLoadFailed(true);
        setError("服务暂不可用，无法读取来信。请稍后重试。");
      }
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    initialLoad();
  }, []);
  useEffect(() => {
    const refresh = () => {
      if (!pending.current && !draft) reload().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [draft]);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function open(l: Letter) {
    await run(async () => {
      await api(`letters/${l.id}/read`, {});
      await reload();
      setLetterId(l.id);
      setDraft("");
      key.current = crypto.randomUUID();
      setScreen("letter");
      window.scrollTo(0, 0);
    });
  }
  async function send() {
    await run(async () => {
      const submitted = { letterId, text: draft.trim(), key: key.current };
      let result;
      try {
        result = await api(`letters/${submitted.letterId}/respond`, {
          text: submitted.text,
          key: submitted.key,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) throw e;
        const existing = await api(
          `response-result?key=${submitted.key}`,
        ).catch(() => null);
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(submitted.text),
        );
        const hash = Array.from(new Uint8Array(bytes))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        if (
          existing?.id &&
          existing.letter_id === submitted.letterId &&
          existing.payloadHash === hash
        )
          result = existing;
        else throw e;
      }
      if (result.safety) {
        setSafety(true);
        reload().catch(() => {});
        return;
      }
      setDraft("");
      setScreen("success");
      window.scrollTo(0, 0);
      reload().catch(() => {});
    });
  }
  const cat = state?.participant.cat_name ?? "小咪",
    letter = state?.letters.find((x) => x.id === letterId),
    latest = state?.letters.find(
      (x) => !x.read_at && !x.skipped_at && !x.response,
    ),
    intercepted = safety || state?.participant.safety_state === "INTERCEPTED";
  return (
    <div className={s.shell}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
        <span className={s.meta}>内部体验</span>
      </header>
      <p className={s.note}>
        仅限内部邀请体验 · 使用合成输入检查，尚无正式安全识别服务。
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {!loaded ? (
        <p>正在打开来信……</p>
      ) : loadFailed ? (
        <main>
          <h1>暂时无法读取来信</h1>
          <button className={s.primary} onClick={() => initialLoad()}>
            重试
          </button>
        </main>
      ) : !state ? (
        <main className={s.main}>
          <h1>打开这次内部体验</h1>
          <p>请使用管理员提供的一次性邀请码。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api("invite", { invite: invite.trim() });
                setInvite("");
                await reload();
              });
            }}
          >
            <label htmlFor="invite">邀请码</label>
            <input
              id="invite"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoComplete="off"
              required
            />
            <button disabled={busy} className={s.primary}>
              进入体验
            </button>
          </form>
          <details>
            <summary>测试与数据说明</summary>
            <p className={s.tip}>
              本轮用于内部产品走查。来信、回应及阅读状态保存在服务器，受邀请会话保护。当前尚未提供个人删除功能，请仅输入合成测试内容。回应不会换取旅行或即时猫回复。
            </p>
          </details>
        </main>
      ) : state.participant.status === "NEW" ? (
        <main>
          <div className={s.scene}>小猫形象 · 内部占位</div>
          <h1>这是一只还在慢慢长大的小猫。</h1>
          <p>
            它会把每天的小事写给你。
            <br />
            你想回的时候就回几句，不想回也没关系。
          </p>
          <p>有时候，它会自己跑出去旅行，再从远方寄信回来。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api("start", { name });
                await reload();
              });
            }}
          >
            <label htmlFor="name">给它起个名字吧</label>
            <input
              id="name"
              maxLength={12}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <button disabled={busy || !name.trim()} className={s.primary}>
              开始一起生活
            </button>
          </form>
        </main>
      ) : intercepted ? (
        <main>
          <h1>独立安全路径</h1>
          <p>内部合成测试已进入独立安全路径，未保存为普通回应。</p>
          <p>这里仅用于验证状态与数据隔离，不提供真实危机识别或专业支持。</p>
        </main>
      ) : screen === "success" ? (
        <main className={s.success}>
          <h1 role="status">送出去啦。</h1>
          <button className={s.primary} onClick={() => setScreen("home")}>
            回到{cat}身边
          </button>
        </main>
      ) : screen === "letter" && letter ? (
        <main>
          <button className={s.quiet} onClick={() => setScreen("inbox")}>
            ← 来信盒
          </button>
          {letter.type === "POSTCARD" ? (
            <>
              <div className={`${s.scene} ${s.postScene}`}>
                旅行画面 · 内部占位
              </div>
              <p className={s.meta}>
                {scenes[letter.snapshot.scene ?? ""]} ·{" "}
                {[letter.snapshot.season, letter.snapshot.timeOfDay]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <h1>{letter.snapshot.title}</h1>
            </>
          ) : (
            <h1>{letter.snapshot.catName}的来信</h1>
          )}
          <p className={s.meta}>
            收到日期：
            {new Date(letter.delivered_at).toLocaleDateString("zh-CN")}
          </p>
          <article className={s.letter}>
            <div className={s.story}>{letter.snapshot.body}</div>
          </article>
          {letter.type === "POSTCARD" ? (
            <>
              <p className={s.signature}>—— {letter.snapshot.catName}</p>
              <button className={s.primary} onClick={() => setScreen("home")}>
                收好这封信
              </button>
            </>
          ) : letter.response ? (
            <>
              <h2>那次你对{letter.snapshot.catName}说：</h2>
              <p className={s.story}>{letter.response}</p>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <label htmlFor="response">你想跟它说什么？</label>
              <textarea
                id="response"
                maxLength={2000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="写几句就好……"
              />
              <div className={s.count}>{draft.length} / 2000</div>
              {letter.snapshot.tip && (
                <details>
                  <summary>看看小提示</summary>
                  <div className={s.inset}>
                    <small>内部草案，尚未专业审核</small>
                    <p className={s.tip}>{letter.snapshot.tip}</p>
                  </div>
                </details>
              )}
              <button className={s.primary} disabled={busy || !draft.trim()}>
                送出去
              </button>
              <button
                type="button"
                disabled={busy}
                className={s.secondary}
                onClick={() =>
                  run(async () => {
                    await api(`letters/${letter.id}/skip`, {});
                    setDraft("");
                    await reload();
                    setScreen("home");
                  })
                }
              >
                这次先不回
              </button>
            </form>
          )}
        </main>
      ) : screen === "inbox" ? (
        <main>
          <h1>来信盒</h1>
          <div className={s.tabs}>
            {["全部", "在家时", "旅行时"].map((f) => (
              <button
                className={filter === f ? s.active : ""}
                key={f}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {state.letters.length === 0 ? (
            <p className={s.empty}>这里还没有来信。</p>
          ) : (
            state.letters
              .filter(
                (l) =>
                  filter === "全部" ||
                  l.type === (filter === "在家时" ? "DEMAND" : "POSTCARD"),
              )
              .map((l) => (
                <button key={l.id} className={s.row} onClick={() => open(l)}>
                  <strong>
                    {l.type === "POSTCARD"
                      ? l.snapshot.title
                      : `${l.snapshot.catName}的来信 · ${l.snapshot.title}`}
                  </strong>
                  <span className={s.meta}>
                    {new Date(l.delivered_at).toLocaleDateString("zh-CN")} ·{" "}
                    {l.type === "POSTCARD" ? "明信片" : "在家时"}
                    {!l.read_at ? " · 未读" : ""}
                  </span>
                </button>
              ))
          )}
        </main>
      ) : (
        <main>
          <h1>
            {cat}{" "}
            <small className={s.meta}>{state.trip ? "旅行中" : "在家"}</small>
          </h1>
          <div className={s.scene}>
            {state.trip ? "旅行画面" : "小猫小场景"} · 内部占位
          </div>
          {state.trip ? (
            <>
              <h2>{cat}出去旅行啦 🐾</h2>
              <p className={s.meta}>它什么时候寄信回来？不知道呢。</p>
            </>
          ) : null}
          {latest ? (
            <>
              <h2>
                {latest.type === "POSTCARD"
                  ? "远方来了一封信！"
                  : "今天有一封来信"}
              </h2>
              {latest.type === "DEMAND" && (
                <p className={s.story}>{latest.snapshot.body}</p>
              )}
              <button className={s.primary} onClick={() => open(latest)}>
                {latest.type === "POSTCARD" ? "打开看看" : "看看来信"}
              </button>
            </>
          ) : (
            <>
              <h2>
                {state.trip ? `${cat}还在外面转悠呢。` : "今天没有新来信。"}
              </h2>
              {!state.trip && <p>{cat}正在窗边追一块光。</p>}
            </>
          )}
          <button className={s.secondary} onClick={() => setScreen("inbox")}>
            看看以前的来信
          </button>
          <button
            disabled={busy}
            className={s.quiet}
            onClick={() =>
              run(async () => {
                await reload();
              })
            }
          >
            刷新来信
          </button>
        </main>
      )}
      {state?.participant.status === "ACTIVE" && !intercepted && (screen === "home" || screen === "inbox") && (
        <nav aria-label="主要导航" className={s.nav}>
          <button
            className={screen === "home" ? s.selected : ""}
            onClick={() => setScreen("home")}
          >
            {cat}
          </button>
          <button
            className={screen === "inbox" ? s.selected : ""}
            onClick={() => setScreen("inbox")}
          >
            来信盒
          </button>
        </nav>
      )}
    </div>
  );
}
