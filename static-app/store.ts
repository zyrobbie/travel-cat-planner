import frozen from "../src/content/frozen.json";
import type { AppState, Letter } from "../src/app/client-api";
export class LocalError extends Error {}
type RecordState = AppState & {
  schema: 1;
  controlRevision: number;
  tripCount: number;
  events: { event: string; at: string; simulation: true }[];
  requests: Record<string, { signature: string; result: unknown }>;
};
const DB = "cat-letters-pages-v1";
let opened: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB, 1);
      } catch {
        reject(
          new LocalError("此浏览器无法保存本机数据，请检查浏览器设置后重试。"),
        );
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("participants"))
          request.result.createObjectStore("participants", {
            keyPath: "participant.id",
          });
      };
      request.onerror = () =>
        reject(
          new LocalError(
            "无法打开本机数据，未建立体验。请检查浏览器存储设置。",
          ),
        );
      request.onblocked = () =>
        reject(
          new LocalError("本机数据正在另一页面更新，请关闭其他体验页后重试。"),
        );
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          opened = null;
        };
        resolve(request.result);
      };
    }).catch((e) => {
      opened = null;
      throw e;
    });
  return opened!;
}
function check(row: RecordState) {
  if (row.schema !== 1)
    throw new LocalError("本机数据版本不兼容，未改写已有数据。");
}
async function write<T>(
  id: string,
  change: (state: RecordState | undefined) => { state: RecordState; result: T },
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    let result: T, problem: unknown;
    let tx: IDBTransaction;
    try {
      tx = db.transaction("participants", "readwrite");
    } catch {
      reject(new LocalError("无法写入本机数据，本次操作尚未保存。"));
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () =>
      reject(
        problem ||
          new LocalError(
            "本机保存失败，本次操作尚未保存。请检查存储空间后重试。",
          ),
      );
    tx.onerror = () => {};
    const store = tx.objectStore("participants"),
      req = store.get(id);
    req.onsuccess = () => {
      try {
        if (req.result) check(req.result);
        const changed = change(req.result);
        result = changed.result;
        store.put(changed.state);
      } catch (e) {
        problem =
          e instanceof LocalError
            ? e
            : new LocalError(
                "本机保存失败，本次操作尚未保存。请检查存储空间后重试。",
              );
        tx.abort();
      }
    };
  });
}
export async function listParticipants(): Promise<RecordState[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("participants", "readonly");
    const r = tx.objectStore("participants").getAll();
    tx.oncomplete = () => {
      try {
        r.result.forEach(check);
        resolve(r.result);
      } catch (e) {
        reject(e);
      }
    };
    tx.onabort = () => reject(new LocalError("无法读取本机体验，请重试。"));
  });
}
export async function readState(id: string): Promise<RecordState> {
  const all = await listParticipants();
  const row = all.find((p) => p.participant.id === id);
  if (!row) throw new LocalError("此本机体验不存在，请在控制台选择已有体验。");
  return row;
}
export async function createParticipant(name: string) {
  if (!name.trim() || name.trim().length > 12)
    throw new LocalError("名字请填写 1–12 个字。");
  const id = crypto.randomUUID();
  return write(id, () => {
    const state: RecordState = {
      schema: 1,
      participant: {
        id,
        cat_name: name.trim(),
        status: "ACTIVE",
        safety_state: "CLEAR",
      },
      trip: null,
      letters: [],
      controlRevision: 0,
      tripCount: 0,
      events: [],
      requests: {},
    };
    return { state, result: state };
  });
}
const event = (s: RecordState, value: string) =>
  s.events.push({
    event: value,
    at: new Date().toISOString(),
    simulation: true,
  });
export async function letterAction(
  id: string,
  letterId: string,
  action: "read" | "skip" | "respond",
  text = "",
) {
  return write<{ ok?: boolean; message?: string; safety?: string }>(
    id,
    (state) => {
      if (!state) throw new LocalError("此本机体验不存在。");
      const l = state.letters.find((x) => x.id === letterId);
      if (!l) throw new LocalError("此体验中没有这封信。");
      const now = new Date().toISOString();
      if (action === "read") {
        l.read_at ??= now;
        return { state, result: { ok: true } };
      }
      if (l.type !== "DEMAND") throw new LocalError("这不是需求卡。");
      if (action === "skip") {
        if (!l.skipped_at) {
          l.skipped_at = now;
          event(state, "SKIPPED");
        }
        l.read_at ??= now;
        return { state, result: { ok: true } };
      }
      const value = text.trim();
      if (!value || value.length > 2000)
        throw new LocalError("请填写 1–2000 字的回应。");
      if (l.response !== null) {
        if (l.response !== value)
          throw new LocalError("这封信已有回应，请重新载入。");
        return { state, result: { message: "送出去啦。" } };
      }
      if (state.participant.safety_state !== "CLEAR")
        throw new LocalError("当前处于独立合成测试路径。");
      if (value === "[SYNTHETIC:UNAVAILABLE]")
        throw new LocalError("合成输入检查不可用，尚未完成发送。");
      if (value === "[SYNTHETIC:INTERCEPT]") {
        state.participant.safety_state = "INTERCEPTED";
        event(state, "SYNTHETIC_INTERCEPTED");
        return { state, result: { safety: "INTERCEPTED" } };
      }
      l.response = value;
      l.read_at ??= now;
      event(state, "RESPONSE_SENT");
      return { state, result: { message: "送出去啦。" } };
    },
  );
}
export async function control(
  id: string,
  action: string,
  contentId: string,
  revision: number,
  key: string,
) {
  return write(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const signature = JSON.stringify([action, contentId, revision]);
    const previous = state.requests[key];
    if (previous) {
      if (previous.signature !== signature)
        throw new LocalError("重复请求与原操作不同，请刷新。");
      return { state, result: previous.result };
    }
    if (state.controlRevision !== revision)
      throw new LocalError("另一页面已推进此体验，请刷新后确认当前状态。");
    if (action === "end-trip") {
      if (!state.trip) throw new LocalError("当前不在旅行。");
      state.trip = null;
      event(state, "TRIP_ENDED");
    } else {
      if (state.participant.safety_state !== "CLEAR")
        throw new LocalError("合成安全路径中不能投递。");
      if (action === "start-trip") {
        if (state.trip) throw new LocalError("已经在旅行中。");
        state.trip = { id: crypto.randomUUID() };
        state.tripCount++;
        event(state, "TRIP_STARTED");
      } else {
        let c;
        if (action === "deliver-demand") {
          if (state.trip) throw new LocalError("旅行中不投递日常卡。");
          c = frozen.items.find(
            (c) =>
              c.type === "DEMAND" &&
              !state.letters.some((l) => l.id.endsWith(":" + c.id)),
          );
          if (!c) throw new LocalError("六张需求卡已全部寄出。");
        } else if (action === "deliver-postcard") {
          if (!state.trip) throw new LocalError("请先独立开始旅行。");
          if (
            state.letters.some(
              (l) =>
                (l as Letter & { tripId?: string }).tripId === state.trip!.id,
            )
          )
            throw new LocalError("这次旅行已经寄过明信片。");
          c = frozen.items.find(
            (c) => c.id === contentId && c.type === "ORDINARY",
          );
          if (!c) throw new LocalError("请选择普通旅行故事。");
          if (state.letters.some((l) => l.id.endsWith(":" + c!.id)))
            throw new LocalError("这封故事已经寄过。");
        } else throw new LocalError("未知的演示操作。");
        const l: Letter & { tripId?: string } = {
          id: `${state.participant.id}:${c.id}`,
          type: c.type === "DEMAND" ? "DEMAND" : "POSTCARD",
          read_at: null,
          skipped_at: null,
          delivered_at: new Date().toISOString(),
          response: null,
          snapshot: {
            title: c.title,
            body: c.body,
            catName: state.participant.cat_name!,
            tip:
              frozen.items.find((t) => t.id === c.id.replace("D-", "TIPS-"))
                ?.body ?? null,
            scene: c.sceneId,
            season: c.narrativeSeason,
            timeOfDay: ("timeOfDay" in c ? c.timeOfDay : null) ?? null,
          },
        };
        if (l.type === "POSTCARD") l.tripId = state.trip!.id;
        state.letters.unshift(l);
        event(
          state,
          l.type === "POSTCARD" ? "POSTCARD_DELIVERED" : "DEMAND_DELIVERED",
        );
      }
    }
    state.controlRevision++;
    const result = { ok: true };
    state.requests[key] = { signature, result };
    return { state, result };
  });
}
export type LocalState = RecordState;
