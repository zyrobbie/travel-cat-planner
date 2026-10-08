import { LocalError, migrateRecord, type LocalState } from "./model";
const DB = "cat-letters-pages-v1";
const VERSION = 4;
let opened: Promise<IDBDatabase> | null = null;
export type Change = { participantId: string; redacted?: string };
const listeners = new Set<(change: Change) => void>();
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("cat-letters-changes")
    : null;
channel?.addEventListener("message", (e) =>
  listeners.forEach((fn) => fn(e.data)),
);
export function subscribe(fn: (change: Change) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function notify(change: Change) {
  listeners.forEach((fn) => fn(change));
  channel?.postMessage(change);
}
function storedRecord(value: unknown): LocalState {
  if (!value || (value as { schema?: number }).schema !== 3)
    throw new LocalError(
      "本机记录与数据库版本不一致，原数据未改写。请保留数据并联系维护者。",
    );
  return migrateRecord(value);
}
export function openLocalDatabase(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest,
        problem: unknown,
        abandoned = false;
      try {
        req = indexedDB.open(DB, VERSION);
      } catch {
        reject(
          new LocalError("此浏览器无法保存本机数据，请检查浏览器设置后重试。"),
        );
        return;
      }
      req.onblocked = () => {
        abandoned = true;
        reject(
          new LocalError(
            "请关闭仍在使用旧版的其他体验页，再重试升级；原数据保留。",
          ),
        );
      };
      req.onupgradeneeded = (event) => {
        const tx = req.transaction!;
        const initializedAt = Date.now();
        if (abandoned) {
          tx.abort();
          return;
        }
        // Version 4 adds only the binding gate. Existing schema-3 rows, including
        // unknown fields, are not rewritten or enumerated by this upgrade.
        if (!req.result.objectStoreNames.contains("accountBindings"))
          req.result.createObjectStore("accountBindings", {
            keyPath: "sourceId",
          });
        if (!req.result.objectStoreNames.contains("participants")) {
          if (event.oldVersion !== 0) {
            problem = new LocalError(
              "已有本机数据库缺少参与者存储，升级已中止。请保留原数据，不要重建体验。",
            );
            tx.abort();
            return;
          }
          req.result.createObjectStore("participants", {
            keyPath: "participant.id",
          });
          return;
        }
        if (event.oldVersion >= 3) return;
        const cursor = tx.objectStore("participants").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          try {
            const upgraded = migrateRecord(row.value, initializedAt);
            if (row.value.schema !== 3) row.update(upgraded);
            row.continue();
          } catch (e) {
            problem =
              e instanceof LocalError
                ? e
                : new LocalError(
                    "本机升级失败，原记录未改写。请保留数据后重试。",
                  );
            tx.abort();
          }
        };
      };
      req.onerror = () =>
        reject(
          problem ||
            new LocalError(
              "无法打开或升级本机数据，原记录未改写。请保留数据后重试。",
            ),
        );
      req.onsuccess = () => {
        if (abandoned) {
          req.result.close();
          return;
        }
        if (
          !req.result.objectStoreNames.contains("participants") ||
          !req.result.objectStoreNames.contains("accountBindings")
        ) {
          req.result.close();
          reject(new LocalError("本机存储结构不完整，原记录已保留。"));
          return;
        }
        req.result.onversionchange = () => {
          req.result.close();
          opened = null;
        };
        resolve(req.result);
      };
    }).catch((e) => {
      opened = null;
      throw e;
    });
  return opened!;
}
export async function write<T>(
  id: string,
  change: (state: LocalState | undefined) => {
    state: LocalState;
    result: T;
    changed?: boolean;
  },
  redacted?: string,
): Promise<T> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction,
      result: T,
      problem: unknown,
      didWrite = false;
    try {
      tx = db.transaction(["participants", "accountBindings"], "readwrite");
    } catch {
      reject(new LocalError("无法写入本机数据，本次操作尚未保存。"));
      return;
    }
    tx.oncomplete = () => {
      resolve(result);
      if (didWrite) notify({ participantId: id, redacted });
    };
    tx.onabort = () =>
      reject(
        problem ||
          new LocalError(
            "本机保存失败，本次操作尚未保存。请检查存储空间后重试。",
          ),
      );
    tx.onerror = () => {};
    const store = tx.objectStore("participants"),
      gate = tx.objectStore("accountBindings").get(id);
    gate.onsuccess = () => {
      try {
        if (gate.result !== undefined)
          throw new LocalError(
            gate.result?.phase === "BOUND"
              ? "这只小猫已绑定账号，请从账号继续；本机记录和草稿已保留。"
              : "这只小猫的账号绑定尚待确认，本机写入已暂停；原记录和草稿已保留，请继续确认绑定结果。",
          );
        const req = store.get(id);
        req.onsuccess = () => {
          try {
            const changed = change(
              req.result ? storedRecord(req.result) : undefined,
            );
            migrateRecord(changed.state);
            if (changed.state.participant.id !== id)
              throw new LocalError("本机写入不属于当前小猫，原记录未改写。");
            result = changed.result;
            if (changed.changed !== false) {
              store.put(changed.state);
              didWrite = true;
            }
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
export async function listParticipants(): Promise<LocalState[]> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("participants", "readonly"),
      r = tx.objectStore("participants").getAll();
    tx.oncomplete = () => {
      try {
        resolve(r.result.map(storedRecord));
      } catch (e) {
        reject(e);
      }
    };
    tx.onabort = () => reject(new LocalError("无法读取本机体验，请重试。"));
  });
}
export async function readState(id: string) {
  const db = await openLocalDatabase();
  return new Promise<LocalState>((resolve, reject) => {
    const tx = db.transaction("participants", "readonly"),
      req = tx.objectStore("participants").get(id);
    tx.oncomplete = () => {
      try {
        if (!req.result)
          throw new LocalError("此本机体验不存在，请在控制台选择已有体验。");
        const row = storedRecord(req.result);
        if (row.participant.id !== id)
          throw new LocalError("本机小猫标识不一致，原记录未改写。");
        resolve(row);
      } catch (error) {
        reject(error);
      }
    };
    tx.onabort = () => reject(new LocalError("无法读取本机体验，请重试。"));
  });
}
