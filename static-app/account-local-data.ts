export type LocalAccountCleanup = {
  complete: boolean;
  draftsRemoved: number;
  requestsRemoved: number;
};

/** Only keys owned by this account on this origin are eligible for removal. */
export function clearAccountLocalData(
  accountId: string,
  includeRequests = false,
): LocalAccountCleanup {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      accountId,
    )
  )
    throw new Error("账号标识不完整，本机记录未清理。");
  const result = { complete: true, draftsRemoved: 0, requestsRemoved: 0 };
  const remove = (getStorage: () => Storage, prefix: string) => {
    let removed = 0;
    try {
      const storage = getStorage();
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) {
        try {
          storage.removeItem(key);
          if (storage.getItem(key) === null) removed++;
          else result.complete = false;
        } catch {
          result.complete = false;
        }
      }
    } catch {
      result.complete = false;
    }
    return removed;
  };
  result.draftsRemoved = remove(
    () => localStorage,
    `cat-letters:account-draft:v1:${accountId}:`,
  );
  if (includeRequests)
    result.requestsRemoved = remove(
      () => sessionStorage,
      `cat-letters:account-request:v1:${accountId}:`,
    );
  return result;
}
