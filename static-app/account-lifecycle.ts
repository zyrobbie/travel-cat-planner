export type ExportJob = {
  id: string;
  status: "QUEUED" | "BUILDING" | "READY" | "FAILED" | "EXPIRED" | "REVOKED";
  createdAt: string;
  expiresAt: string | null;
  filename: string | null;
  error: string | null;
};
export type DeletionTask = {
  requestId: string;
  accountId: string;
  status: "PREPARED" | "PENDING" | "FAILED" | "COMPLETE";
  requestedAt: string | null;
  completedAt: string | null;
  error: string | null;
  finished: boolean;
};
export type DeletionProgress = Omit<DeletionTask, "status"> & {
  status: DeletionTask["status"] | "UNKNOWN";
};
export type AccountMessage =
  | { type: "SESSION_CHANGED"; accountId: string }
  | { type: "ACCOUNT_LOGOUT" | "DRAFTS_CLEARED"; accountId: string }
  | { type: "ACCOUNT_DELETING"; accountId: string; requestId: string };

const intentKey = "cat-letters:account-deletion-intent:v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function rememberDeletionIntent(task: DeletionTask) {
  // No email, cat, token or archive is cached. The actual authority is HttpOnly.
  sessionStorage.setItem(
    intentKey,
    JSON.stringify({ accountId: task.accountId, requestId: task.requestId }),
  );
}
export function readDeletionIntent(): DeletionProgress | null {
  try {
    const raw = sessionStorage.getItem(intentKey);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!uuid.test(value.accountId) || !uuid.test(value.requestId)) return null;
    return {
      accountId: value.accountId,
      requestId: value.requestId,
      status: "UNKNOWN",
      requestedAt: null,
      completedAt: null,
      error: null,
      finished: false,
    };
  } catch {
    return null;
  }
}
export function forgetDeletionIntent(requestId: string) {
  const existing = readDeletionIntent();
  if (existing?.requestId === requestId) sessionStorage.removeItem(intentKey);
}
export function lifecycleRequestKey(
  accountId: string,
  operation: "export" | "delete-prepare",
) {
  const storageKey = `cat-letters:account-request:v1:${accountId}:privacy:${operation}`;
  const saved = sessionStorage.getItem(storageKey);
  if (saved && uuid.test(saved)) return saved;
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, key);
  return key;
}
export function clearLifecycleRequestKey(
  accountId: string,
  operation: "export" | "delete-prepare",
) {
  sessionStorage.removeItem(
    `cat-letters:account-request:v1:${accountId}:privacy:${operation}`,
  );
}
