import type { AppClient, SourceView, ViewState } from "./app-client";
import type { AppearanceId, Draft, Letter, ResponseRecord } from "./model";

export class AccountError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export type AccountSession = {
  id: string;
  email_normalized: string;
  cat: { id: string } | null;
};
export async function accountRequest<T>(
  path: string,
  body?: unknown,
  accountId?: string,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/e4/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accountId ? { "X-Catletters-Account": accountId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AccountError(
      "连接暂时中断。没有切换到本机模式，请重试确认结果。",
      0,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new AccountError(
      data.error || "服务暂不可用，请稍后再试。",
      response.status,
    );
  return data as T;
}
type Summary = {
  id: string;
  type: Letter["type"];
  title: string;
  deliveredAt: string;
  readAt: string | null;
  skippedAt: string | null;
  responseId?: string | null;
  responseStatus?: "ACTIVE" | "DELETED" | null;
};
type ResponseSummary = {
  id: string;
  letterId: string;
  currentRevision: number;
  status: "ACTIVE" | "DELETED";
  title: string;
  text?: string | null;
  at?: string | null;
};
type Detail = {
  id: string;
  type: Letter["type"];
  snapshot: Letter["snapshot"];
  deliveredAt: string;
  readAt: string;
  skippedAt: string | null;
  tripId?: string;
  storyId?: string;
  responseId?: string;
  response: { id: string; revision: number; text: string; at: string } | null;
  responseStatus: "ACTIVE" | "DELETED" | null;
};
type World = {
  cat: { id: string; name: string; appearanceId: AppearanceId };
  world: { status: "HOME" | "TRAVEL"; tripId: string | null };
  safety: "CLEAR" | "INTERCEPTED";
  stateRevision: number;
};

export function createAccountClient(
  account: AccountSession,
  expired: () => void,
): AppClient & { dispose: () => void } {
  let active = true,
    catId = account.cat?.id ?? "",
    current: ViewState | null = null,
    version = 0;
  const controller = new AbortController();
  const details = new Map<string, Detail>();
  const clearedDrafts = new Set<string>();
  let storageNotice = "",
    cleanupNotice = "";
  const assertActive = () => {
    if (!active) throw new AccountError("登录状态已变化，请重新打开。", 401);
  };
  const request = async <T>(path: string, body?: unknown) => {
    assertActive();
    try {
      const value = await accountRequest<T>(
        path,
        body,
        account.id,
        controller.signal,
      );
      assertActive();
      return value;
    } catch (e) {
      if (e instanceof AccountError && e.status === 401 && active) {
        active = false;
        controller.abort();
        details.clear();
        current = null;
        expired();
      }
      throw e;
    }
  };
  const draftKey = (letter: string, kind: string) =>
    `cat-letters:account-draft:v1:${account.id}:${catId}:${encodeURIComponent(letter)}:${kind}`;
  function clearDraft(letter: string) {
    clearedDrafts.add(letter);
    try {
      for (const kind of ["reply", "edit"])
        localStorage.removeItem(draftKey(letter, kind));
    } catch {
      cleanupNotice =
        "提交已成功，但本机旧草稿暂未清理。旧草稿不会覆盖账号记录。";
    }
  }
  function draftsFor(
    letters: Letter[],
    responses: Record<string, ResponseRecord>,
  ) {
    const drafts: ViewState["drafts"] = Object.create(null);
    storageNotice = cleanupNotice;
    for (const letter of letters) {
      if (clearedDrafts.has(letter.id)) continue;
      for (const kind of ["reply", "edit"] as const) {
        const key = draftKey(letter.id, kind);
        let raw: string | null;
        try {
          raw = localStorage.getItem(key);
        } catch {
          storageNotice =
            "账号记录已读取；本机草稿暂不可用，请检查浏览器存储设置。";
          continue;
        }
        if (!raw) continue;
        let d: Draft;
        try {
          d = JSON.parse(raw);
        } catch {
          storageNotice =
            "一份本机草稿格式异常，已保留原记录；账号来信仍可继续阅读。";
          continue;
        }
        if (
          !d ||
          d.kind !== kind ||
          typeof d.text !== "string" ||
          d.text.length > 2000 ||
          typeof d.updatedAt !== "string"
        ) {
          storageNotice =
            "一份本机草稿格式异常，已保留原记录；账号来信仍可继续阅读。";
          continue;
        }
        const response = letter.responseId
          ? responses[letter.responseId]
          : undefined;
        if (
          !letter.read_at ||
          (kind === "reply" && response) ||
          (kind === "edit" && (!response || response.status !== "ACTIVE"))
        )
          continue;
        if (
          kind === "edit" &&
          (d.responseId !== response?.id ||
            d.revision !== response.currentRevision)
        ) {
          storageNotice =
            "已有更正提交成功或回应版本已变化。旧草稿仍在本机，未覆盖当前回应。";
          continue;
        }
        if (!drafts[letter.id] || d.updatedAt > drafts[letter.id].updatedAt)
          drafts[letter.id] = d;
      }
    }
    return drafts;
  }
  function mergeDetail(detail: Detail) {
    if (!current) throw new Error("请先读取小猫状态。");
    version++;
    details.set(detail.id, detail);
    const existing = current.letters.find((l) => l.id === detail.id);
    const responseId =
      detail.response?.id ?? detail.responseId ?? existing?.responseId;
    const letter: Letter = {
      id: detail.id,
      type: detail.type,
      snapshot: detail.snapshot,
      delivered_at: detail.deliveredAt,
      read_at: detail.readAt,
      skipped_at: detail.skippedAt,
      response: detail.response?.text ?? null,
      responseId,
      tripId: detail.tripId,
      storyId: detail.storyId,
    };
    const responses: Record<string, ResponseRecord> = Object.assign(
      Object.create(null),
      current.responses,
    );
    if (detail.response)
      responses[detail.response.id] = {
        id: detail.response.id,
        letterId: detail.id,
        currentRevision: detail.response.revision,
        status: "ACTIVE",
        revisions: [
          {
            revision: detail.response.revision,
            text: detail.response.text,
            at: detail.response.at,
          },
        ],
      };
    else if (
      responseId &&
      detail.responseStatus === "DELETED" &&
      responses[responseId]
    )
      responses[responseId] = {
        ...responses[responseId],
        status: "DELETED",
        revisions: [],
      };
    const letters = existing
      ? current.letters.map((l) => (l.id === letter.id ? letter : l))
      : [letter, ...current.letters];
    current = {
      ...current,
      letters,
      responses,
      drafts: draftsFor(letters, responses),
      storageNotice,
    };
    return current;
  }
  async function load() {
    if (!catId) return null;
    const started = version;
    async function projection() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await Promise.all([
          request<World>("v1/state"),
          request<{ letters: Summary[]; stateRevision: number }>("v1/letters"),
          request<{ responses: ResponseSummary[]; stateRevision: number }>(
            "v1/responses",
          ),
        ]);
        if (
          result[0].stateRevision === result[1].stateRevision &&
          result[1].stateRevision === result[2].stateRevision
        )
          return result;
      }
      throw new Error("来信状态正在更新，请稍后重试。");
    }
    const [world, mailbox, sent] = await projection();
    if (world.cat.id !== catId)
      throw new Error("小猫记录已变化，请退出后重新登录。");
    if (started !== version) return current;
    const responses: Record<string, ResponseRecord> = Object.create(null);
    for (const row of sent.responses) {
      responses[row.id] = {
        id: row.id,
        letterId: row.letterId,
        currentRevision: row.currentRevision,
        status: row.status,
        revisions:
          row.status === "ACTIVE"
            ? [
                {
                  revision: row.currentRevision,
                  text: row.text ?? null,
                  at: row.at ?? null,
                },
              ]
            : [],
      };
      if (row.status === "DELETED") {
        const cached = details.get(row.letterId);
        if (cached)
          details.set(row.letterId, {
            ...cached,
            response: null,
            responseStatus: "DELETED",
          });
      }
    }
    const letters = mailbox.letters.map((row): Letter => {
      const known = details.get(row.id),
        r = sent.responses.find((r) => r.letterId === row.id);
      return {
        id: row.id,
        type: row.type,
        delivered_at: row.deliveredAt,
        read_at: row.readAt,
        skipped_at: row.skippedAt,
        responseId: row.responseId ?? r?.id,
        response: r?.status === "ACTIVE" ? (r.text ?? null) : null,
        // Unopened entries have metadata only. Only a successful read/detail response supplies art and copy.
        snapshot: known?.snapshot ?? {
          title: row.title,
          body: "",
          catName: world.cat.name,
          tip: null,
          scene: null,
          season: null,
          timeOfDay: null,
        },
        tripId: known?.tripId,
        storyId: known?.storyId,
      };
    });
    current = {
      participant: {
        id: catId,
        cat_name: world.cat.name,
        appearanceId: world.cat.appearanceId,
        status: "ACTIVE",
        safety_state: world.safety,
      },
      trip:
        world.world.status === "TRAVEL" && world.world.tripId
          ? { id: world.world.tripId }
          : null,
      letters,
      responses,
      drafts: draftsFor(letters, responses),
      storageNotice,
    };
    return current;
  }
  async function mutation(
    path: string,
    operation: string,
    payload: Record<string, unknown>,
    target: string,
  ) {
    version++;
    // Persist only a payload hash and request key, never a second copy of response text.
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const storageKey = `cat-letters:account-request:v1:${account.id}:${catId}:${operation}:${encodeURIComponent(target)}`;
    const stored = sessionStorage.getItem(storageKey);
    let key = crypto.randomUUID();
    if (stored) {
      const previous = JSON.parse(stored);
      if (previous.signature === signature) key = previous.key;
    }
    sessionStorage.setItem(storageKey, JSON.stringify({ signature, key }));
    try {
      return await request<{ message?: string; safety?: string }>(path, {
        ...payload,
        key,
      });
    } catch (e) {
      if (!(e instanceof AccountError) || (e.status !== 0 && e.status < 500))
        throw e;
      const resultPath =
        operation === "ADOPT"
          ? `requests/${key}`
          : `v1/requests/${operation}/${key}`;
      const result = await request<{
        pending?: boolean;
        message?: string;
        safety?: string;
      }>(resultPath);
      if (result.pending) throw e;
      return result;
    }
  }
  const client: AppClient & { dispose: () => void } = {
    mode: "account",
    selectedId: () => `${account.id}:${catId}`,
    listParticipants: async () => [],
    subscribe: () => () => {},
    dispose: () => {
      active = false;
      controller.abort();
      current = null;
      details.clear();
    },
    detail: async (id) => {
      const value = await request<{ letter: Detail }>(
        `v1/letters/${encodeURIComponent(id)}/detail`,
      );
      return mergeDetail(value.letter);
    },
    sources: async (id) =>
      (
        await request<{ sources: SourceView[] }>(
          `v1/letters/${encodeURIComponent(id)}/sources`,
        )
      ).sources,
    api: async (path, body) => {
      if (path === "state") return load();
      if (path === "start") {
        await mutation(
          "cat/adopt",
          "ADOPT",
          { name: body?.name, appearanceId: body?.appearanceId },
          "cat",
        );
        const fresh = await request<AccountSession>("account");
        if (!fresh.cat) throw new Error("领养结果仍在确认中，请重试。");
        catId = fresh.cat.id;
        return { ok: true };
      }
      const match = path.match(/^letters\/(.+)\/(read|respond|skip)$/);
      if (!match) throw new Error("没有此账号操作。");
      const [, id, action] = match,
        remote = `v1/letters/${encodeURIComponent(id)}/${action}`;
      if (action === "read") {
        const result = await request<{ letter: Detail; firstRead: boolean }>(
          remote,
          {},
        );
        return {
          state: mergeDetail(result.letter),
          firstRead: result.firstRead,
        };
      }
      if (action === "respond") {
        const result = await mutation(
          remote,
          "SEND_RESPONSE",
          {
            text: body?.text,
            expectedResponseId: body?.expectedResponseId ?? null,
          },
          id,
        );
        clearDraft(id);
        return result;
      }
      return request(remote, {});
    },
    saveDraft: async (id, letterId, kind, text, responseId, revision) => {
      assertActive();
      if (id !== catId) throw new Error("小猫记录已变化，草稿未保存。");
      if (text.length > 2000) throw new Error("草稿最多2000字。");
      const value: Draft = {
        kind,
        text,
        responseId,
        revision,
        updatedAt: new Date().toISOString(),
      };
      clearedDrafts.delete(letterId);
      if (text)
        localStorage.setItem(draftKey(letterId, kind), JSON.stringify(value));
      else localStorage.removeItem(draftKey(letterId, kind));
      return { ok: true };
    },
    editResponse: async (id, responseId, expectedRevision, text) => {
      assertActive();
      if (id !== catId) throw new Error("小猫记录已变化。");
      const result = await mutation(
        `v1/responses/${encodeURIComponent(responseId)}/edit`,
        "EDIT_RESPONSE",
        { text, expectedRevision },
        responseId,
      );
      const letter = current?.responses[responseId]?.letterId;
      if (letter) clearDraft(letter);
      return result;
    },
    deleteResponse: async (id, responseId, expectedRevision) => {
      assertActive();
      if (id !== catId) throw new Error("小猫记录已变化。");
      const result = await mutation(
        `v1/responses/${encodeURIComponent(responseId)}/delete`,
        "DELETE_RESPONSE",
        { expectedRevision },
        responseId,
      );
      const letter = current?.responses[responseId]?.letterId;
      if (letter) {
        clearDraft(letter);
        details.delete(letter);
      }
      return result;
    },
  };
  return client;
}
