import { useEffect, useRef, useState } from "react";
import { api, type AppState, type Letter } from "./local-api";
import s from "../src/app/page.module.css";
import LocalControl from "./Control";
import ResponseManager from "./ResponseManager";
import SourceHistory from "./SourceHistory";
import {
  listParticipants,
  subscribe,
  LocalError,
  saveDraft,
  type LocalState,
} from "./store";
import { selectedId } from "./local-api";
import { APPEARANCES, countCatName, isAppearanceId, type AppearanceId } from "./model";
import { responsiveCat } from "./assets";
import { HomeScene, EventScene, PostcardScene, type HomePose } from "./Scenes";
import { homePoseForNavigation } from "../ui-daily-core-v1/home-poses.mjs";
import { effectiveTime } from "./calendar-plan";
const REVIEW_MODE = ["localhost", "127.0.0.1"].includes(location.hostname) &&
  !new URLSearchParams(location.search).has("product");
const ORIGINAL_PREVIEW_URL = "https://zyrobbie.github.io/travel-cat-planner/ui-daily-core-v1/index.html";
const catNames: Record<AppearanceId, string> = {
  "cat-01": "橘白", "cat-02": "狸花", "cat-03": "奶油白", "cat-04": "三花",
};
const catLines: Record<AppearanceId, [string, string]> = {
  "cat-01": ["喜欢晒太阳，", "也喜欢挨着你。"],
  "cat-02": ["耳朵总是先听见", "一点新鲜事。"],
  "cat-03": ["轻轻靠过来，", "陪你慢一点。"],
  "cat-04": ["发现一点小事，", "就想告诉你。"],
};
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
    [name, setName] = useState(""),
    [appearance, setAppearance] = useState<AppearanceId | null>(null),
    [adoptionStep, setAdoptionStep] = useState<"choose" | "name" | "confirm" | "confirmed">("choose"),
    [screen, setScreen] = useState<"home" | "inbox" | "responses" | "letter" | "success">(
      "home",
    ),
    [letterId, setLetterId] = useState<string | null>(null),
    [replyExpanded, setReplyExpanded] = useState(false),
    [draft, setDraft] = useState(""),
    [filter, setFilter] = useState("全部"),
    [unreadOnly, setUnreadOnly] = useState(false),
    [safety, setSafety] = useState(false);
  const [manage, setManage] = useState(false),
    [message, setMessage] = useState(""),
    [firstRead, setFirstRead] = useState(false);
  const generation = useRef(0);
  const [draftStatus, setDraftStatus] = useState("");
  const draftWrite = useRef(0);
  const draftSavePending = useRef<Promise<unknown>>(Promise.resolve());
  const homePose = useRef<{ catId: string; pose: HomePose } | null>(null);
  const [saved, setSaved] = useState<LocalState[]>([]);
  const pending = useRef(false);
  const currentView = useRef<{ responseId?: string }>({});
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
      const restored = await reload();
      if (epoch === generation.current && restored) {
        const entry = Object.entries(restored.drafts).sort((a, b) =>
          b[1].updatedAt.localeCompare(a[1].updatedAt),
        )[0];
        const hasUnread = restored.letters.some((l) => !l.read_at);
        if (entry && !hasUnread) {
          setLetterId(entry[0]);
          setDraft(entry[1].kind === "reply" ? entry[1].text : "");
          setManage(entry[1].kind === "edit");
          setReplyExpanded(entry[1].kind === "reply");
          setScreen("letter");
          setFirstRead(false);
          setDraftStatus("已恢复本机草稿，尚未发送。");
        } else if (hasUnread) {
          setScreen("home");
          setLetterId(null);
          setManage(false);
          setDraft("");
          setReplyExpanded(false);
        }
      }
      const rows = await listParticipants();
      if (epoch === generation.current) {
        setSaved(rows);
      }
    } catch (e) {
      if (epoch === generation.current) {
        setLoadFailed(true);
        setError(
          e instanceof LocalError
            ? e.message
            : "无法读取本机数据，原数据保留，请稍后重试。",
        );
      }
    } finally {
      if (epoch === generation.current) setLoaded(true);
    }
  }
  useEffect(() => {
    initialLoad();
  }, []);
  useEffect(() => {
    const sync = () => {
      const viewport = window.visualViewport;
      const zoomed = !!viewport && Math.abs(viewport.scale - 1) > 0.01;
      const height = zoomed ? window.innerHeight : (viewport?.height || window.innerHeight);
      const top = zoomed ? 0 : (viewport?.pageTop ?? ((viewport?.offsetTop || 0) + window.scrollY));
      document.documentElement.style.setProperty("--e3-viewport-height", `${Math.max(1, height)}px`);
      document.documentElement.style.setProperty("--e3-viewport-top", `${top}px`);
    };
    sync();
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync);
    return () => {
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync);
    };
  }, []);
  useEffect(() => {
    const refresh = () => {
      if (!pending.current && document.visibilityState === "visible")
        reload().catch((e) => setError(e.message));
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 15000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const welcome = state?.calendar.nodes.find(
      (node) => node.id === "welcome:d0" && !node.result,
    );
    if (!welcome || !state) return;
    const remaining = welcome.at - effectiveTime(state.calendar, Date.now());
    const timer = window.setTimeout(() => {
      if (!pending.current && document.visibilityState === "visible")
        reload().catch((e) => setError(e.message));
    }, Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(
    () =>
      subscribe((change) => {
        if (change.redacted) {
          setSaved([]);
          if (
            change.participantId === selectedId() &&
            change.redacted === currentView.current.responseId
          ) {
            setDraft("");
            setManage(false);
          }
        }
        if (change.participantId === selectedId() && !pending.current)
          reload().catch((e) => setError(e.message));
        listParticipants()
          .then(setSaved)
          .catch(() => {});
      }),
    [],
  );
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
      const committed = (await api(`letters/${l.id}/read`, {})) as {
        state: AppState;
        firstRead: boolean;
      };
      const fresh = committed.state;
      if (epoch !== generation.current || pid !== selectedId()) return;
      setState(fresh);
      setLetterId(l.id);
      setFirstRead(committed.firstRead);
      setManage(fresh.drafts[l.id]?.kind === "edit");
      setReplyExpanded(fresh.drafts[l.id]?.kind === "reply");
      setMessage("");
      setDraft(
        fresh.drafts[l.id]?.kind === "reply" ? fresh.drafts[l.id].text : "",
      );
      setDraftStatus(fresh.drafts[l.id] ? "已恢复本机草稿，尚未发送。" : "");
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
        expectedResponseId:
          state?.letters.find((l) => l.id === submitted.letterId)?.responseId ??
          null,
      });
      if (
        submitted.pid !== selectedId() ||
        submitted.epoch !== generation.current
      )
        return;
      if ((result as { safety?: string }).safety) {
        setSafety(true);
        setDraft("");
        reload().catch(() => {});
        return;
      }
      setDraft("");
      setReplyExpanded(false);
      setScreen("success");
      window.scrollTo(0, 0);
      reload().catch(() => {});
    });
  }
  async function openManaged(l: Letter) {
    await open(l);
    if (l.response) setManage(true);
  }
  const cat = state?.participant.cat_name ?? "小咪",
    appearanceId = isAppearanceId(state?.participant.appearanceId) ? state!.participant.appearanceId : null,
    poseCatId = state ? (appearanceId ?? `legacy:${state.participant.id}`) : "",
    letter = state?.letters.find((x) => x.id === letterId),
    latest = state?.letters.find((x) => !x.read_at),
    visibleLetters = (state?.letters ?? []).filter((l) =>
      (filter === "全部" || l.type === (filter === "小猫来信" ? "DEMAND" : "POSTCARD")) &&
      (!unreadOnly || !l.read_at)),
    intercepted = safety || state?.participant.safety_state === "INTERCEPTED";
  if (state && homePose.current?.catId !== poseCatId) {
    const navigationType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    homePose.current = {
      catId: poseCatId,
      pose: homePoseForNavigation({ catId: poseCatId, navigationType, historyPose: history.state?.catLettersHomePoseV1 }) as HomePose,
    };
  }
  useEffect(() => {
    if (!state || !homePose.current || homePose.current.catId !== poseCatId) return;
    const previous = history.state;
    if (previous === null || Object.prototype.toString.call(previous) === "[object Object]")
      history.replaceState({ ...previous, catLettersHomePoseV1: { catId: poseCatId, pose: homePose.current.pose } }, "");
  }, [poseCatId]);
  useEffect(() => {
    const main = document.querySelector<HTMLElement>(".e3-app-shell > main");
    main?.scrollTo({ top: 0, behavior: "instant" });
  }, [screen, letterId, adoptionStep]);
  currentView.current = {
    responseId:
      letter?.responseId &&
      state?.responses[letter.responseId]?.status === "ACTIVE"
        ? letter.responseId
        : undefined,
  };
  async function selectExperience(id: string) {
    if (pending.current) return;
    generation.current++;
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
    setDraft("");
    setReplyExpanded(false);
    setManage(false);
    setMessage("");
    setLetterId(null);
    setScreen("home");
    setSafety(false);
    setControlOpen(false);
    setAppearance(null);
    setName("");
    setAdoptionStep("choose");
    await initialLoad();
  }
  return (
    <div className={`${s.shell} e3-app-shell`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
        {REVIEW_MODE && <button
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
        </button>}
      </header>
      {REVIEW_MODE && <details className={s.note}>
        <summary>本机体验与数据说明</summary>
        <p>
          数据仅保存在此浏览器，清除浏览器数据后可能丢失。没有云端账号或跨设备同步。演示推进中的不同体验仅做本机数据分区，不构成安全隔离；请使用合成内容。不接
          AI 或真实安全识别服务。
        </p>
      </details>}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {!controlOpen &&
        loaded &&
        !loadFailed &&
        !intercepted &&
        screen === "letter" &&
        latest &&
        latest.id !== letterId && (
          <aside className={s.note}>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => {
                setManage(false);
                setScreen("home");
              }}
            >
              有一封新来信
            </button>
          </aside>
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
          <button className={s.secondary} onClick={() => selectExperience("")}>
            查看本机已有体验
          </button>
        </main>
      ) : !state ? (
        <main className="e3-adoption-page">
          {adoptionStep === "choose" && <aside className="e3-separate-data">
            新版在本机独立测试；<a href={ORIGINAL_PREVIEW_URL}>原审阅入口</a>和记录继续保留。
            两份数据不迁入、不合并，也不会互相覆盖。
          </aside>}
          {adoptionStep === "choose" && saved.length > 0 && (
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
          {adoptionStep === "choose" ? <>
              <h1>选一只你喜欢的小猫吧</h1>
              <p className={s.note}>以后，它会一直是陪你生活和旅行的那一只。</p>
              <fieldset className="e3-adoption-cats">
                <legend className="e3-visually-hidden">选择小猫外观</legend>
                {APPEARANCES.map((id) => {
                  const source = responsiveCat(id);
                  return <label key={id} className={`e3-adoption-card${appearance === id ? " is-selected" : ""}`}>
                    <input type="radio" name="cat-appearance" value={id} checked={appearance === id} onChange={() => setAppearance(id)} aria-label={`选择${catNames[id]}猫`} />
                    <img src={source.src} srcSet={source.srcSet} sizes="(max-width:600px) 42vw, 180px" alt={`${catNames[id]}猫完整全身像`} />
                    <strong>{catNames[id]}</strong>
                    <span className="e3-choice-line"><span>{catLines[id][0]}</span><span>{catLines[id][1]}</span></span>
                    <span className="e3-choice-control">{appearance === id ? "◉ 已选择" : "○ 想认识它"}</span>
                  </label>;
                })}
              </fieldset>
              <button type="button" className={s.primary} disabled={!appearance} onClick={() => { setAdoptionStep("name"); window.scrollTo(0, 0); }}>继续</button>
              <p className={s.note}>数据仅保存在此浏览器，清除浏览器数据后可能丢失。</p>
            </> : adoptionStep === "name" && appearance ? <>
              <button type="button" className={s.quiet} onClick={() => setAdoptionStep("choose")}>← 返回</button>
              <h1>给它起个名字吧</h1>
              <div className="e3-adoption-single"><img {...responsiveCat(appearance)} sizes="200px" alt={`${catNames[appearance]}猫完整全身像`} /></div>
              <form onSubmit={(e) => { e.preventDefault(); if (name.trim() && countCatName(name) <= 12) setAdoptionStep("confirm"); }}>
                <label htmlFor="name">给它起个名字吧</label>
                <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="给它起个名字" required />
                <p className="e3-name-count">{countCatName(name)} / 12</p>
                <button className={s.primary} disabled={!name.trim() || countCatName(name) > 12}>继续</button>
              </form>
            </> : adoptionStep === "confirm" && appearance ? <>
              <button type="button" className={s.quiet} onClick={() => setAdoptionStep("name")}>← 返回</button>
              <h1>确认领养</h1>
              <div className="e3-adoption-single"><img {...responsiveCat(appearance)} sizes="200px" alt={`${catNames[appearance]}猫完整全身像`} /></div>
              <h2 className="e3-confirm-name">{name.trim()}</h2>
              <p>以后，就和它一起生活啦。</p>
              <p className="e3-adoption-rule">这份本机体验确认后，小猫的外观就固定了。请确认你的选择。</p>
              <div className="e3-confirm-actions">
                <button type="button" className={s.secondary} disabled={busy} onClick={() => setAdoptionStep("choose")}>再看看</button>
                <button type="button" className={s.primary} disabled={busy} onClick={() => run(async () => {
                  await api("start", { name, appearanceId: appearance });
                  setAdoptionStep("confirmed");
                  await reload();
                })}>确认领养</button>
              </div>
            </> : <>
              <h1>已确认领养</h1>
              <p>正在打开这只小猫的本机记录。如果暂时没能读取，可以再试一次。</p>
              <button type="button" className={s.primary} onClick={() => run(async () => { await reload(); })}>重新读取</button>
            </>}
        </main>
      ) : intercepted ? (
        <main>
          <h1>独立安全路径</h1>
          <p>内部合成测试已进入独立安全路径，未保存为普通回应。</p>
          <p>这里仅用于验证状态与数据隔离，不提供真实危机识别或专业支持。</p>
        </main>
      ) : screen === "success" ? (
        <main className={`${s.success} e3-success-page`}>
          <div className="e3-success-content">
            <div className="e3-success-panel">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m5 12 4 4L19 6" />
              </svg>
              <h1 role="status">送出去啦。</h1>
            </div>
            <button className={s.primary} onClick={() => setScreen("home")}>
              回到{cat}身边
            </button>
          </div>
        </main>
      ) : screen === "letter" && letter ? (
        <main className="e3-detail-page">
          <button
            disabled={busy}
            className={s.quiet}
            onClick={() => {
              if (manage) {
                setError("请先点“取消管理”保存草稿，再返回来信盒。");
                return;
              }
              setManage(false);
              setScreen("inbox");
            }}
          >
            ← 来信盒
          </button>
          {letter.type === "POSTCARD" ? (
            <>
              <PostcardScene letter={letter} appearance={appearanceId} />
              <p className={s.meta}>
                {scenes[letter.snapshot.scene ?? ""]} ·{" "}
                {[letter.snapshot.season, letter.snapshot.timeOfDay]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <h1>{letter.snapshot.title}</h1>
            </>
          ) : (
            <>
              <EventScene letter={letter} appearance={appearanceId} />
              <h1>{letter.snapshot.catName}的来信</h1>
            </>
          )}
          <p className={s.meta}>
            收到日期：
            {new Date(letter.delivered_at).toLocaleDateString("zh-CN")}
          </p>
          <article className={s.letter}>
            {letter.type === "DEMAND" && <h2 className="e3-demand-title">{letter.snapshot.title}</h2>}
            <div className={s.story}>{letter.snapshot.body}</div>
          </article>
          {message && !letter.response && <p role="status">{message}</p>}
          {letter.type === "POSTCARD" ? (
            <>
              <p className={s.signature}>—— {letter.snapshot.catName}</p>
              {!firstRead && <SourceHistory letter={letter} state={state} />}
              <button className={s.primary} onClick={() => setScreen("home")}>
                收好这封信
              </button>
            </>
          ) : letter.responseId && state.responses[letter.responseId]?.status === "DELETED" ? (
            <section className="e3-deleted-response">
              <h2>你送出的回应</h2>
              <p>这条回应已删除。原来的来信和已寄出的旅行信仍保留。</p>
            </section>
          ) : letter.response ? (
            <>
              <h2>那次你对{letter.snapshot.catName}说：</h2>
              <p className={s.story}>{letter.response}</p>
              {message && <p role="status">{message}</p>}
              {manage && letter.responseId ? (
                <ResponseManager
                  key={letter.responseId}
                  participantId={state.participant.id}
                  response={state.responses[letter.responseId]}
                  initialDraft={state.drafts[letter.id]}
                  onBusy={(value) => {
                    pending.current = value;
                    setBusy(value);
                  }}
                  onCancel={async () => {
                    await reload();
                    setManage(false);
                  }}
                  onDone={(result) => {
                    setManage(false);
                    setDraft("");
                    setMessage(result.message ?? "");
                    if (result.safety) setSafety(true);
                    reload().catch(() =>
                      setError("保存已完成，但读取暂时失败，请刷新来信。"),
                    );
                  }}
                />
              ) : (
                <button
                  className={s.secondary}
                  disabled={busy}
                  onClick={() => {
                    setManage(true);
                    setMessage("");
                  }}
                >
                  管理这条回应
                </button>
              )}
            </>
          ) : replyExpanded ? (
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
                onChange={(e) => {
                  const text = e.target.value,
                    sequence = ++draftWrite.current;
                  setDraft(text);
                  setDraftStatus("正在保存草稿…");
                  draftSavePending.current = saveDraft(
                    state.participant.id,
                    letter.id,
                    "reply",
                    text,
                    letter.responseId ?? null,
                    null,
                  )
                    .then(() => {
                      if (sequence === draftWrite.current)
                        setDraftStatus(
                          text ? "草稿已保存在本机，尚未发送。" : "",
                        );
                    })
                    .catch((e) => {
                      if (sequence === draftWrite.current)
                        setDraftStatus(`草稿尚未保存：${e.message}`);
                    });
                }}
                placeholder="写几句就好……"
              />
              <div className={s.count}>{draft.length} / 2000</div>
              {draftStatus && <p className={s.meta}>{draftStatus}</p>}
              {letter.snapshot.tip && (
                <details>
                  <summary>看看小提示</summary>
                  <div className={s.inset}>
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
                    await draftSavePending.current.catch(() => {});
                    if (draft) await saveDraft(state.participant.id, letter.id, "reply", draft, letter.responseId ?? null, null);
                    await api(`letters/${letter.id}/skip`, {});
                    setDraft("");
                    setReplyExpanded(false);
                    await reload();
                    setScreen("home");
                  })
                }
              >
                这次先不回
              </button>
            </form>
          ) : (
            <div className="e3-read-actions">
              <button type="button" className={s.primary} disabled={busy} onClick={() => setReplyExpanded(true)}>给它回信</button>
              <button type="button" className={s.secondary} disabled={busy} onClick={() => run(async () => {
                await draftSavePending.current.catch(() => {});
                if (draft) await saveDraft(state.participant.id, letter.id, "reply", draft, letter.responseId ?? null, null);
                await api(`letters/${letter.id}/skip`, {});
                setReplyExpanded(false);
                setDraft("");
                await reload();
                setScreen("home");
              })}>这次先不回</button>
            </div>
          )}
        </main>
      ) : screen === "responses" ? (
        <main className="e3-inbox-page">
          <button className={s.quiet} onClick={() => setScreen("inbox")}>← 返回来信盒</button>
          <h1>管理我的回应</h1>
          <p className="e3-inbox-subtitle">送给小猫的话，都可以在这里回看。</p>
          {state.letters.filter((l) => l.type === "DEMAND" && !!l.responseId).length ?
            state.letters.filter((l) => l.type === "DEMAND" && !!l.responseId).map((l) =>
              <button key={l.id} className={s.row} onClick={() => openManaged(l)}>
                <span className={s.meta}>送给{l.snapshot.catName}的回应{l.response ? "" : " · 已删除"}</span>
                <strong>{l.snapshot.title}</strong>
                <span className={s.meta}>收到：{new Date(l.delivered_at).toLocaleDateString("zh-CN")}</span>
              </button>) : <p className={s.empty}>还没有送出的回应。</p>}
        </main>
      ) : screen === "inbox" ? (
        <main className="e3-inbox-page">
          <div className="e3-inbox-heading"><h1>来信盒</h1><button type="button" className={s.quiet} onClick={() => setScreen("responses")}>管理我的回应</button></div>
          <p className="e3-inbox-subtitle">它写过的小事，都收在这里。</p>
          <div className={s.tabs}>
            {["全部", "小猫来信", "旅行来信"].map((f) => (
              <button
                className={filter === f ? s.active : ""}
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                {f}
              </button>
            ))}
            <label className="e3-unread-toggle"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />只看未读</label>
          </div>
          {visibleLetters.length === 0 ? (
            <section className="e3-inbox-empty">
              <h2>{state.letters.length ? "没有符合筛选的来信" : "来信盒里还没有信。"}</h2>
              <p>{state.letters.length ? "换一个筛选，以前的信都还在。" : "小猫写给你的信，会收在这里。"}</p>
              {state.letters.length > 0 && <button type="button" className={s.quiet} onClick={() => { setFilter("全部"); setUnreadOnly(false); }}>查看全部</button>}
            </section>
          ) : (
            visibleLetters.map((l) => (
                <button key={l.id} className={s.row} onClick={() => open(l)}>
                  <span className="e3-inbox-kind">{l.type === "POSTCARD" ? "旅行来信" : "小猫来信"}<span>{l.read_at ? "已读" : "● 未读"}</span></span>
                  <strong>
                    {l.snapshot.title}
                  </strong>
                  <span className={s.meta}>
                    收到：{new Date(l.delivered_at).toLocaleDateString("zh-CN")}
                    {state.drafts[l.id]?.kind === "reply" ? " · 有一份未写完的回应" : ""}
                  </span>
                </button>
              ))
          )}
        </main>
      ) : (
        <main className="e3-home-page">
          <h1>
            {cat}{" "}
            <small className={s.meta}>{state.trip ? "旅行中" : "在家"}</small>
          </h1>
          <HomeScene key={`${appearanceId}:${!!state.trip}:${homePose.current?.pose}`} appearance={appearanceId} name={cat} trip={!!state.trip} pose={homePose.current?.pose ?? "sit"} />
          {state.trip ? (
            <div className="e3-life-copy">
              <h2>{cat}出去旅行啦 🐾</h2>
              <p className={s.meta}>它什么时候寄信回来？不知道呢。</p>
            </div>
          ) : null}
          {latest ? (
            <section className="e3-new-letter">
              <h2>
                {latest.type === "POSTCARD"
                  ? state.trip ? "旅行中寄来一封信" : "旅行时寄来的信，还没打开"
                  : "有一封来信，还没打开"}
              </h2>
              <p className={s.meta}>收到：{new Date(latest.delivered_at).toLocaleDateString("zh-CN")}</p>
              {latest.type === "DEMAND" && (
                <p className={s.story}>{latest.snapshot.body}</p>
              )}
              <button className={s.primary} onClick={() => open(latest)}>
                {latest.type === "POSTCARD" ? "打开看看" : "看看来信"}
              </button>
            </section>
          ) : state.trip ? (
            <p className="e3-empty-letter">暂时没有新来信。</p>
          ) : (
            <div className="e3-life-copy">
              <h2>今天没有新来信。</h2>
            </div>
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
        (screen === "home" || screen === "inbox" || screen === "responses") && (
          <nav aria-label="主要导航" className={s.nav}>
            <button
              className={screen === "home" ? s.selected : ""}
              onClick={() => setScreen("home")}
            >
              {cat}
            </button>
            <button
              className={screen === "inbox" || screen === "responses" ? s.selected : ""}
              onClick={() => setScreen("inbox")}
            >
              来信盒
            </button>
          </nav>
        )}
    </div>
  );
}
