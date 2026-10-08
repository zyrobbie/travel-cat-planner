import { z } from "zod";
import {
  buildLegacyTransfer,
  parseLegacyTransfer,
  type LegacyTransfer,
} from "../src/shared/legacy-transfer";
import { notify, openLocalDatabase } from "./database";
import { LocalError } from "./model";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const targetUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const metadataSchema = z.strictObject({
  targetUrl,
  accountId: z.uuid(),
  key: z.uuid(),
  bundleHash: checksum,
});
const gateSchema = metadataSchema.extend({
  sourceId: z.uuid(),
  phase: z.enum(["PENDING", "BOUND"]),
});
const receiptSchema = z.strictObject({
  logicalCatId: z.uuid(),
  bundleHash: checksum,
  catId: z.uuid(),
  importBatchId: z.uuid(),
  stateRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type BindingGate = z.infer<typeof gateSchema>;
export type BindingMetadata = z.infer<typeof metadataSchema>;
export type BindingReceipt = z.infer<typeof receiptSchema>;
const cancellationSchema = z.strictObject({
  cancelled: z.literal(true),
  key: z.uuid(),
  bundleHash: checksum,
});
export type BindingCancellation = z.infer<typeof cancellationSchema>;

function localFailure(error: unknown): LocalError {
  return error instanceof LocalError
    ? error
    : new LocalError("本机绑定信息不完整或保存失败，原记录未改写。");
}
function parseGate(value: unknown, id: string): BindingGate | null {
  if (value === undefined) return null;
  const gate = gateSchema.parse(value);
  if (gate.sourceId !== id)
    throw new LocalError("本机绑定标识不一致，原记录已保留。");
  return gate;
}

// Match the server's full-payload checksum. No Node/server imports or persisted
// copy of the bundle: hashing happens before opening any IndexedDB transaction.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
export async function hashBindingBundle(
  bundle: LegacyTransfer,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson(parseLegacyTransfer(bundle)),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readBindingGate(id: string): Promise<BindingGate | null> {
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accountBindings", "readonly"),
      req = tx.objectStore("accountBindings").get(id);
    tx.oncomplete = () => {
      try {
        resolve(parseGate(req.result, id));
      } catch (error) {
        reject(localFailure(error));
      }
    };
    tx.onabort = () =>
      reject(new LocalError("无法读取本机绑定状态，请重试；原记录已保留。"));
  });
}

/** Atomically compare one selected archive and freeze every cooperative local writer. */
export async function freezeForAccountBinding(
  id: string,
  expectedBundle: LegacyTransfer,
  metadata: BindingMetadata,
): Promise<BindingGate> {
  let expected: LegacyTransfer, meta: BindingMetadata;
  try {
    expected = parseLegacyTransfer(expectedBundle);
    meta = metadataSchema.parse(metadata);
    if (expected.sourceExperienceId !== id)
      throw new LocalError("已切换小猫，请重新检查要绑定的记录。");
    if ((await hashBindingBundle(expected)) !== meta.bundleHash)
      throw new LocalError("绑定内容与预检摘要不一致，请重新检查。");
  } catch (error) {
    throw localFailure(error);
  }
  const expectedJson = JSON.stringify(expected);
  const pending: BindingGate = { ...meta, sourceId: id, phase: "PENDING" };
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["participants", "accountBindings"], "readwrite");
    const bindings = tx.objectStore("accountBindings"),
      prior = bindings.get(id);
    let problem: unknown,
      changed = false;
    const fail = (error: unknown) => {
      problem = localFailure(error);
      tx.abort();
    };
    tx.oncomplete = () => {
      resolve(pending);
      if (changed) notify({ participantId: id });
    };
    tx.onabort = () =>
      reject(
        problem ??
          new LocalError("绑定暂停状态未能保存，尚未确认绑定；原记录已保留。"),
      );
    tx.onerror = () => {};
    prior.onsuccess = () => {
      try {
        const gate = parseGate(prior.result, id);
        if (gate?.phase === "BOUND")
          throw new LocalError(
            "这只小猫已绑定账号，请从账号继续；原记录已保留。",
          );
        if (
          gate &&
          (gate.targetUrl !== meta.targetUrl ||
            gate.accountId !== meta.accountId ||
            gate.key !== meta.key ||
            gate.bundleHash !== meta.bundleHash)
        )
          throw new LocalError(
            "这只小猫已有待确认的绑定，请沿原账号和原请求确认结果。",
          );
        const row = tx.objectStore("participants").get(id);
        row.onsuccess = () => {
          try {
            if (!row.result)
              throw new LocalError("当前本机小猫不存在，尚未确认绑定。");
            if (
              JSON.stringify(buildLegacyTransfer(row.result)) !== expectedJson
            )
              throw new LocalError(
                "本机记录在预检后已变化，请重新检查再确认绑定。",
              );
            if (!gate) {
              bindings.put(pending);
              changed = true;
            }
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    };
  });
}

/** Only a matching, validated server receipt closes a pending handoff. */
export async function markBindingComplete(
  id: string,
  key: string,
  receipt: BindingReceipt,
): Promise<BindingGate> {
  let confirmed: BindingReceipt;
  try {
    z.uuid().parse(key);
    confirmed = receiptSchema.parse(receipt);
    if (confirmed.logicalCatId !== id)
      throw new LocalError(
        "账号回执不属于这只小猫，原记录继续保留。请重试确认结果。",
      );
  } catch (error) {
    throw localFailure(error);
  }
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accountBindings", "readwrite"),
      store = tx.objectStore("accountBindings"),
      req = store.get(id);
    let result: BindingGate,
      problem: unknown,
      changed = false;
    tx.oncomplete = () => {
      resolve(result);
      if (changed) notify({ participantId: id });
    };
    tx.onabort = () =>
      reject(
        problem ??
          new LocalError("账号回执尚未保存在本机，请重试确认；原记录已保留。"),
      );
    tx.onerror = () => {};
    req.onsuccess = () => {
      try {
        const gate = parseGate(req.result, id);
        if (
          !gate ||
          gate.key !== key ||
          gate.bundleHash !== confirmed.bundleHash
        )
          throw new LocalError(
            "账号回执与原绑定请求不一致，请继续确认原请求结果。",
          );
        result = { ...gate, phase: "BOUND" };
        if (gate.phase !== "BOUND") {
          store.put(result);
          changed = true;
        }
      } catch (error) {
        problem = localFailure(error);
        tx.abort();
      }
    };
  });
}

/** Release only after the server's cancellation fence prevents a late commit. */
export async function releaseBindingGate(
  id: string,
  key: string,
  bundleHash: string,
  cancellation: BindingCancellation,
): Promise<void> {
  try {
    const receipt = cancellationSchema.parse(cancellation);
    if (receipt.key !== key || receipt.bundleHash !== bundleHash)
      throw new LocalError("取消回执与原绑定请求不一致，本机暂停状态未解除。");
  } catch (error) {
    throw localFailure(error);
  }
  const db = await openLocalDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accountBindings", "readwrite"),
      store = tx.objectStore("accountBindings"),
      req = store.get(id);
    let problem: unknown;
    tx.oncomplete = () => {
      resolve();
      notify({ participantId: id });
    };
    tx.onabort = () =>
      reject(
        problem ?? new LocalError("本机暂停状态尚未解除，请重试确认取消结果。"),
      );
    tx.onerror = () => {};
    req.onsuccess = () => {
      try {
        const gate = parseGate(req.result, id);
        if (
          !gate ||
          gate.phase !== "PENDING" ||
          gate.key !== key ||
          gate.bundleHash !== bundleHash
        )
          throw new LocalError(
            "取消回执与待确认的绑定不一致，本机记录未改写。",
          );
        store.delete(id);
      } catch (error) {
        problem = localFailure(error);
        tx.abort();
      }
    };
  });
}
