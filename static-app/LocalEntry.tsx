import { useCallback, useEffect, useRef, useState } from "react";
import App from "./App";
import { readState, subscribe } from "./database";
import { selectedId } from "./local-api";
import {
  buildLegacyTransfer,
  type LegacyTransfer,
} from "../src/shared/legacy-transfer";
import { accountBindingUrl } from "./binding-config";
import { newBindingNonce, serveBindingBridge } from "./binding-bridge";
import {
  readBindingGate,
  freezeForAccountBinding,
  markBindingComplete,
  releaseBindingGate,
  hashBindingBundle,
  type BindingGate,
  type BindingReceipt,
  type BindingCancellation,
} from "./binding-storage";
import s from "../src/app/page.module.css";

type ActiveHandoff = {
  sourceId: string;
  popup: Window;
  bridge: ReturnType<typeof serveBindingBridge>;
  expiresAt: number;
  bundle?: LegacyTransfer;
  accountId?: string;
  finished: boolean;
  attempted?: { key: string; bundleHash: string };
  final?: {
    op: "COMPLETE" | "RELEASE" | "CLOSE";
    receipt?: unknown;
    result: unknown;
  };
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("保存窗口的消息不完整，请重新开始。");
  return value as Record<string, unknown>;
};
function sameFinalReceipt(
  op: "COMPLETE" | "RELEASE" | "CLOSE",
  prior: unknown,
  received: unknown,
) {
  if (op === "CLOSE") return prior === undefined && received === undefined;
  if (
    !prior ||
    !received ||
    typeof prior !== "object" ||
    typeof received !== "object" ||
    Array.isArray(prior) ||
    Array.isArray(received)
  )
    return false;
  const fields =
    op === "COMPLETE"
      ? [
          "logicalCatId",
          "bundleHash",
          "catId",
          "importBatchId",
          "stateRevision",
        ]
      : ["cancelled", "key", "bundleHash"];
  const expected = prior as Record<string, unknown>,
    actual = received as Record<string, unknown>;
  return (
    Object.keys(expected).length === fields.length &&
    Object.keys(actual).length === fields.length &&
    fields.every(
      (field) =>
        Object.hasOwn(expected, field) &&
        Object.hasOwn(actual, field) &&
        expected[field] === actual[field],
    )
  );
}

export default function LocalEntry() {
  const targetUrl = accountBindingUrl();
  const [gate, setGate] = useState<BindingGate | null>(null);
  const [loading, setLoading] = useState(true),
    [binding, setBinding] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const active = useRef<ActiveHandoff | null>(null),
    readSequence = useRef(0),
    verifiedSource = useRef<string | null>(null);
  const refreshGate = useCallback(async () => {
    const sequence = ++readSequence.current,
      id = selectedId();
    try {
      const next = id ? await readBindingGate(id) : null;
      if (sequence === readSequence.current && selectedId() === id) {
        verifiedSource.current = id;
        setGate(next);
        setLoading(false);
      }
    } catch (e) {
      if (sequence === readSequence.current && selectedId() === id) {
        setError((e as Error).message);
        // A transient background check must not discard a committed reading
        // view for this same source. Every write still checks the durable gate
        // inside its own transaction; initial/changed sources remain blocked.
        setLoading(verifiedSource.current !== id);
      }
    }
  }, []);
  useEffect(() => {
    void refreshGate();
    const unsub = subscribe((change) => {
      if (change.participantId === selectedId()) void refreshGate();
    });
    const selected = () => {
      verifiedSource.current = null;
      setLoading(true);
      void refreshGate();
    };
    window.addEventListener("hashchange", selected);
    window.addEventListener("focus", refreshGate);
    const timer = setInterval(() => {
      const handoff = active.current;
      if (
        handoff &&
        !handoff.finished &&
        (handoff.popup.closed || Date.now() >= handoff.expiresAt)
      ) {
        handoff.bridge.dispose();
        active.current = null;
        handoff.bundle = undefined;
        setError(
          "账号窗口已关闭或超时。请重新打开，继续确认保存结果；原本机记录仍然保留。",
        );
        void refreshGate();
      }
    }, 1000);
    return () => {
      unsub();
      clearInterval(timer);
      window.removeEventListener("hashchange", selected);
      window.removeEventListener("focus", refreshGate);
      active.current?.bridge.dispose();
    };
  }, [refreshGate]);

  function begin() {
    if (!targetUrl) return;
    const id = selectedId();
    if (!id) {
      setError("请先打开要保存的小猫。");
      return;
    }
    if (gate && gate.targetUrl !== targetUrl) {
      setError(
        "账号服务地址已变化，请联系维护者确认原绑定结果；原记录仍然保留。",
      );
      return;
    }
    const previous = active.current;
    if (previous?.bridge.isRunning()) {
      setError("正在确认上一项操作，请稍后重试。");
      return;
    }
    previous?.bridge.dispose();
    if (previous && !previous.popup.closed) previous.popup.close();
    const nonce = newBindingNonce(),
      url = new URL(targetUrl);
    url.hash = new URLSearchParams({
      binding: nonce,
      sourceOrigin: location.origin,
    }).toString();
    // Keep this synchronous with the user's click so blockers can be reported honestly.
    const popup = window.open(url.href, "_blank", "popup");
    if (!popup) {
      setBinding(true);
      setError(
        gate
          ? "账号窗口被浏览器阻止。请允许打开新窗口后继续确认原保存结果；原记录保持暂停。"
          : "账号窗口被浏览器阻止。请允许打开新窗口后重试；尚未保存或上传记录。",
      );
      return;
    }
    setBinding(true);
    setError("");
    setNotice("请在账号窗口登录并确认这只小猫，保持此页面打开。");
    const handoff = {
      sourceId: id,
      popup,
      finished: false,
      expiresAt: Date.now() + 15 * 60 * 1000,
    } as ActiveHandoff;
    const ensureCurrent = () => {
      if (
        active.current !== handoff ||
        selectedId() !== id ||
        Date.now() >= handoff.expiresAt
      )
        throw new Error("原本机页面已变化或超时，请回到原页面重新开始。");
    };
    handoff.bridge = serveBindingBridge(
      popup,
      url.origin,
      nonce,
      async (op, payload) => {
        ensureCurrent();
        const data = record(payload ?? {});
        if (handoff.finished) {
          if (
            handoff.final?.op === op &&
            sameFinalReceipt(
              handoff.final.op,
              handoff.final.receipt,
              data.receipt,
            )
          )
            return handoff.final.result;
          throw new Error("这次保存流程已经结束，请回到原页面重新开始。");
        }
        if (op === "READ") {
          if (
            typeof data.accountId !== "string" ||
            typeof data.hasCat !== "boolean"
          )
            throw new Error("请先完成账号登录。");
          const currentGate = await readBindingGate(id);
          ensureCurrent();
          if (
            currentGate &&
            (currentGate.accountId !== data.accountId ||
              currentGate.targetUrl !== targetUrl)
          )
            throw new Error(
              "这只小猫正在保存到另一个账号。请使用原账号继续确认结果。",
            );
          if (!currentGate && data.hasCat)
            throw new Error(
              "这个账号已经有一只小猫，不能覆盖或合并。原本机记录没有上传。",
            );
          const bundle = buildLegacyTransfer(await readState(id));
          ensureCurrent();
          if (
            currentGate &&
            (await hashBindingBundle(bundle)) !== currentGate.bundleHash
          )
            throw new Error(
              "原本机内容与待确认请求不一致，请保留原记录并联系维护者。",
            );
          ensureCurrent();
          handoff.bundle = bundle;
          handoff.accountId = data.accountId;
          return { bundle, gate: currentGate };
        }
        if (op === "CLOSE") {
          if (await readBindingGate(id))
            throw new Error(
              "保存结果尚未确认，请先在账号窗口确认保存或取消结果。",
            );
          ensureCurrent();
          handoff.finished = true;
          setBinding(false);
          setNotice("");
          setError("");
          handoff.final = { op: "CLOSE", result: { closed: true } };
          return handoff.final.result;
        }
        if (!handoff.bundle || !handoff.accountId)
          throw new Error("请先登录并检查当前小猫。");
        if (op === "FREEZE") {
          if (
            data.accountId !== handoff.accountId ||
            typeof data.key !== "string" ||
            typeof data.bundleHash !== "string"
          )
            throw new Error("账号或保存请求已变化，请重新确认。");
          handoff.attempted = { key: data.key, bundleHash: data.bundleHash };
          const next = await freezeForAccountBinding(id, handoff.bundle, {
            targetUrl,
            accountId: handoff.accountId,
            key: data.key,
            bundleHash: data.bundleHash,
          });
          ensureCurrent();
          setGate(next);
          setNotice("正在确认保存结果，本机记录已暂停修改。");
          return next;
        }
        const currentGate = await readBindingGate(id);
        ensureCurrent();
        if (op === "RELEASE" && !currentGate && handoff.attempted) {
          const receipt = record(data.receipt);
          if (
            receipt.cancelled !== true ||
            receipt.key !== handoff.attempted.key ||
            receipt.bundleHash !== handoff.attempted.bundleHash
          )
            throw new Error("取消回执与原保存请求不一致。");
          handoff.finished = true;
          handoff.bundle = undefined;
          handoff.final = {
            op: "RELEASE",
            receipt: data.receipt,
            result: { released: true },
          };
          setGate(null);
          setBinding(false);
          setError("");
          setNotice("");
          return handoff.final.result;
        }
        if (!currentGate || currentGate.accountId !== handoff.accountId)
          throw new Error("没有匹配的待确认保存请求。");
        if (op === "COMPLETE") {
          const next = await markBindingComplete(
            id,
            currentGate.key,
            data.receipt as BindingReceipt,
          );
          ensureCurrent();
          setGate(next);
          handoff.finished = true;
          handoff.bundle = undefined;
          setBinding(false);
          setError("");
          setNotice("已保存到账号。原本机记录和草稿仍然保留。");
          handoff.final = {
            op: "COMPLETE",
            receipt: data.receipt,
            result: { complete: true },
          };
          return handoff.final.result;
        }
        if (op === "RELEASE") {
          await releaseBindingGate(
            id,
            currentGate.key,
            currentGate.bundleHash,
            data.receipt as BindingCancellation,
          );
          ensureCurrent();
          handoff.finished = true;
          handoff.bundle = undefined;
          setGate(null);
          setBinding(false);
          setNotice("");
          setError("");
          handoff.final = {
            op: "RELEASE",
            receipt: data.receipt,
            result: { released: true },
          };
          return handoff.final.result;
        }
        throw new Error("此保存操作不受支持。");
      },
    );
    active.current = handoff;
  }

  async function returnLocal() {
    if (active.current?.bridge.isRunning()) {
      setError("正在确认上一项操作，请稍后再返回。");
      return;
    }
    active.current?.bridge.dispose();
    active.current?.popup.close();
    active.current = null;
    const currentGate = await readBindingGate(selectedId());
    if (currentGate) {
      setGate(currentGate);
      setError("请先在账号窗口确认保存或取消结果。");
      return;
    }
    setBinding(false);
    setError("");
    setNotice("");
    await refreshGate();
  }

  if (!loading && !gate && !binding)
    return <App onBindSelected={targetUrl ? begin : undefined} />;
  return (
    <div className={`${s.shell} e3-app-shell`}>
      <header className={s.header}>
        <span className={s.brand}>有猫来信</span>
      </header>
      <main>
        <h1>
          {gate?.phase === "BOUND"
            ? "已保存到账号"
            : gate
              ? "继续确认保存结果"
              : binding
                ? "正在保存这只小猫"
                : "正在打开本机来信……"}
        </h1>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        {gate && (
          <p>
            原本机记录和草稿已保留。
            {gate.phase === "PENDING"
              ? "结果确认前，本机不会继续修改这只小猫。"
              : "请从账号入口继续与小猫生活。"}
          </p>
        )}
        {gate?.phase === "BOUND" && targetUrl === gate.targetUrl ? (
          <a className={s.primary} href={targetUrl}>
            进入账号
          </a>
        ) : (
          (binding || gate?.phase === "PENDING") && (
            <>
              {targetUrl && (
                <button type="button" className={s.primary} onClick={begin}>
                  继续确认保存结果
                </button>
              )}
              {!gate && (
                <button
                  type="button"
                  className={s.secondary}
                  onClick={() =>
                    void returnLocal().catch((e) => setError(e.message))
                  }
                >
                  返回本机
                </button>
              )}
            </>
          )
        )}
        {loading && (
          <button
            type="button"
            className={s.secondary}
            onClick={() => void refreshGate()}
          >
            重试打开本机记录
          </button>
        )}
        {gate && (!targetUrl || targetUrl !== gate.targetUrl) && (
          <p role="alert">
            原账号入口暂不可用，请联系维护者；本机记录仍然保留。
          </p>
        )}
      </main>
    </div>
  );
}
