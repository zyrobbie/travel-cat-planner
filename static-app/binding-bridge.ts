import { allowedBindingSource } from "./binding-config";

export const BINDING_PROTOCOL = "catletters-binding-v1";
export type BindingOperation =
  "READ" | "FREEZE" | "COMPLETE" | "RELEASE" | "CLOSE";
const operations = new Set<BindingOperation>([
  "READ",
  "FREEZE",
  "COMPLETE",
  "RELEASE",
  "CLOSE",
]);
type Envelope = {
  protocol: string;
  nonce: string;
  requestId: string;
  op?: BindingOperation;
  payload?: unknown;
  ok?: boolean;
  value?: unknown;
  error?: string;
};
const isEnvelope = (value: unknown): value is Envelope =>
  !!value &&
  typeof value === "object" &&
  (value as Envelope).protocol === BINDING_PROTOCOL &&
  typeof (value as Envelope).nonce === "string" &&
  typeof (value as Envelope).requestId === "string" &&
  /^[a-zA-Z0-9-]{16,80}$/.test((value as Envelope).requestId);

export function newBindingNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Requests are serialized. No archive is sent until the authenticated account requests READ. */
export function serveBindingBridge(
  popup: Window,
  targetOrigin: string,
  nonce: string,
  handler: (op: BindingOperation, payload: unknown) => Promise<unknown>,
) {
  let disposed = false;
  let running = false;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (
      disposed ||
      event.source !== popup ||
      event.origin !== targetOrigin ||
      !isEnvelope(message) ||
      message.nonce !== nonce ||
      !message.op ||
      !operations.has(message.op)
    )
      return;
    const reply = (result: {
      ok: boolean;
      value?: unknown;
      error?: string;
    }) => {
      if (!disposed)
        popup.postMessage(
          {
            protocol: BINDING_PROTOCOL,
            nonce,
            requestId: message.requestId,
            ...(Date.now() >= expiresAt
              ? {
                  ok: false,
                  error:
                    "保存窗口已超时，请回原页面重新打开；待确认记录仍然保留。",
                }
              : result),
          },
          targetOrigin,
        );
    };
    if (Date.now() >= expiresAt) {
      reply({ ok: false });
      return;
    }
    if (running) {
      reply({ ok: false, error: "正在确认上一项操作，请稍后重试。" });
      return;
    }
    running = true;
    void handler(message.op, message.payload)
      .then(
        (value) => reply({ ok: true, value }),
        (error: unknown) =>
          reply({
            ok: false,
            error:
              error instanceof Error ? error.message : "本机记录暂时无法读取。",
          }),
      )
      .finally(() => {
        running = false;
      });
  };
  window.addEventListener("message", listener);
  return {
    isRunning: () => running,
    dispose: () => {
      disposed = true;
      window.removeEventListener("message", listener);
    },
  };
}

export type AccountBindingBridge = {
  request: <T>(op: BindingOperation, payload?: unknown) => Promise<T>;
  dispose: () => void;
};

export function receiveBindingBridge(): AccountBindingBridge | null {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("binding")) {
    if (window.name === "catletters-binding-window")
      throw new Error(
        "保存窗口已刷新。请回到原本机页面，重新打开账号窗口继续确认结果。",
      );
    return null;
  }
  const nonce = params.get("binding") ?? "";
  const origin = params.get("sourceOrigin") ?? "";
  history.replaceState(null, "", location.pathname + location.search);
  if (!/^[a-f0-9]{64}$/.test(nonce) || !allowedBindingSource(origin))
    throw new Error("这个本机保存入口不受信任。请回到原页面重新开始。");
  const source: Window | null = window.opener;
  if (!source || source.closed)
    throw new Error(
      "无法连接原本机页面。请回到原页面重试，并允许打开账号窗口。",
    );
  window.name = "catletters-binding-window";
  let disposed = false;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (
      disposed ||
      event.source !== source ||
      event.origin !== origin ||
      !isEnvelope(message) ||
      message.nonce !== nonce
    )
      return;
    const task = pending.get(message.requestId);
    if (!task || typeof message.ok !== "boolean") return;
    clearTimeout(task.timer);
    pending.delete(message.requestId);
    if (message.ok) task.resolve(message.value);
    else
      task.reject(
        new Error(
          typeof message.error === "string"
            ? message.error
            : "原本机页面未完成操作。",
        ),
      );
  };
  window.addEventListener("message", listener);
  return {
    request<T>(op: BindingOperation, payload?: unknown): Promise<T> {
      if (
        disposed ||
        source.closed ||
        window.opener !== source ||
        Date.now() >= expiresAt
      )
        return Promise.reject(
          new Error("保存连接已关闭或超时。请回到原页面继续确认保存结果。"),
        );
      const requestId = crypto.randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(
              "原本机页面没有响应。请保持原页面打开，再重试确认；原记录仍然保留。",
            ),
          );
        }, 15000);
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        source.postMessage(
          { protocol: BINDING_PROTOCOL, nonce, requestId, op, payload },
          origin,
        );
      });
    },
    dispose() {
      disposed = true;
      window.removeEventListener("message", listener);
      for (const task of pending.values()) {
        clearTimeout(task.timer);
        task.reject(new Error("保存窗口已关闭。"));
      }
      pending.clear();
    },
  };
}
