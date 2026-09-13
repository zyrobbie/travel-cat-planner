import { useEffect, useRef, useState } from "react";
import { api, type AppState, type Letter } from "./local-api";
import s from "../src/app/page.module.css";
import LocalControl from "./Control";
import { listParticipants, type LocalState } from "./store";
import { selectedId } from "./local-api";
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
    [controlOpen, setControlOpen] = useState(false),
    [name, setName] = useState("小咪"),
    [screen, setScreen] = useState<"home" | "inbox" | "letter" | "success">(
      "home",
    ),
    [letterId, setLetterId] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [filter, setFilter] = useState("全部"),
    [safety, setSafety] = useState(false);
  const generation = useRef(0);
  const [saved, setSaved] = useState<LocalState[]>([]);
  const pending = useRef(false);
  async function reload() {
    const epoch = generation.current,
      pid = selectedId();
    const data = await api("state");
    if (epoch === generation.current && pid === selectedId())
      setState(data as AppState | null);
    return data as AppState;
  }
  async function initialLoad() {
    const epoch = generation.current;
    setError("");
    setLoadFailed(false);
    try {
      await reload();
      const rows = await listParticipants();
      if (epoch === generation.current) setSaved(rows);
    } catch (e) {
      if (epoch === generation.current) {
        setLoadFailed(true);
        setError("无法读取本机数据，请检查浏览器存储设置后重试。");
      }
    } finally {
      if (epoch === generation.current) setLoaded(true);
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
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (epoch === generation.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function open(l: Letter) {
    await run(async () => {
      const epoch = generation.current,
        pid = selectedId();
      await api(`letters/${l.id}/read`, {});
      await reload();
      if (epoch !== generation.current || pid !== selectedId()) return;
      setLetterId(l.id);
      setDraft("");
      setScreen("letter");
      window.scrollTo(0, 0);
    });
  }
  async function send() {
    await run(async () => {
      const submitted = {
        letterId,
        text: draft.trim(),
        pid: selectedId(),
        epoch: generation.current,
      };
      const result = await api(`letters/${submitted.letterId}/respond`, {
        text: submitted.text,
      });
      if (
        submitted.pid !== selectedId() ||
        submitted.epoch !== generation.current
      )
        return;
      if ((result as { safety?: string }).safety) {
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
  async function selectExperience(id: string) {
    if (pending.current) return;
    generation.current++;
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
    setDraft("");
    setLetterId(null);
    setScreen("home");
    setSafety(false);
    setControlOpen(false);
    await initialLoad();
  }
  return (
    <div className={s.shell}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
        <button
          className={s.quiet}
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (controlOpen) {
                await reload();
                setControlOpen(false);
              } else setControlOpen(true);
            })
          }
        >
          {controlOpen ? "回到体验" : "演示推进"}
        </button>
      </header>
      <details className={s.note}>
        <summary>本机体验与数据说明</summary>
        <p>
          数据仅保存在此浏览器，清除浏览器数据后可能丢失。没有云端账号或跨设备同步。演示推进中的不同体验仅做本机数据分区，不构成安全隔离；请使用合成内容。当前图片为内部占位，不接
          AI 或真实安全识别服务。
        </p>
      </details>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {controlOpen ? (
        <LocalControl onSelect={selectExperience} />
      ) : !loaded ? (
        <p>正在打开本机来信……</p>
      ) : loadFailed ? (
        <main>
          <h1>暂时无法读取本机数据</h1>
          <button className={s.primary} onClick={() => initialLoad()}>
            重试
          </button>
        </main>
      ) : !state ? (
        <main>
          {saved.length > 0 && (
            <section>
              <h2>继续已有体验</h2>
              {saved.map((p) => (
                <button
                  className={s.secondary}
                  disabled={busy}
                  key={p.participant.id}
                  onClick={() => selectExperience(p.participant.id)}
                >
                  继续{p.participant.cat_name}
                </button>
              ))}
              <hr className={s.divider} />
            </section>
          )}
          <div className={s.scene}>小猫形象 · 内部占位</div>
          <h1>这是一只还在慢慢长大的小猫。</h1>
          <p className={s.note}>
            数据仅保存在此浏览器，清除浏览器数据后可能丢失。
          </p>
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
      {!controlOpen &&
        state?.participant.status === "ACTIVE" &&
        !intercepted &&
        (screen === "home" || screen === "inbox") && (
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
