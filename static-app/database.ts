import { LocalError, migrateRecord, type LocalState } from "./model";
const DB = "cat-letters-pages-v1";
const VERSION = 3;
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
function database(): Promise<IDBDatabase> {
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
  const db = await database();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction,
      result: T,
      problem: unknown,
      didWrite = false;
    try {
      tx = db.transaction("participants", "readwrite");
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
      req = store.get(id);
    req.onsuccess = () => {
      try {
        const changed = change(
          req.result ? storedRecord(req.result) : undefined,
        );
        migrateRecord(changed.state);
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
  });
}
export async function listParticipants(): Promise<LocalState[]> {
  const db = await database();
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
  const row = (await listParticipants()).find((p) => p.participant.id === id);
  if (!row) throw new LocalError("此本机体验不存在，请在控制台选择已有体验。");
  return row;
}
