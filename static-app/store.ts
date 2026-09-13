import frozen from "../src/content/frozen.json";
import {
  LocalError,
  eligible,
  stories,
  currentText,
  type LocalState,
  type Letter,
  type Evidence,
  type Review,
} from "./model";
import { write } from "./database";
export { listParticipants, readState, subscribe } from "./database";
export { LocalError } from "./model";
export type { LocalState } from "./model";
export async function createParticipant(name: string) {
  if (!name.trim() || name.trim().length > 12)
    throw new LocalError("名字请填写 1–12 个字。");
  const id = crypto.randomUUID();
  return write(id, () => {
    const state: LocalState = {
      schema: 2,
      responses: {},
      reviews: [],
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
const event = (s: LocalState, value: string) =>
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
  expectedResponseId: string | null = null,
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
      if ((l.responseId ?? null) !== expectedResponseId)
        throw new LocalError("回应记录已变化，请重新载入后再发送。");
      if (state.participant.safety_state !== "CLEAR")
        throw new LocalError("当前处于独立合成测试路径。");
      if (value === "[SYNTHETIC:UNAVAILABLE]")
        throw new LocalError("合成输入检查不可用，尚未完成发送。");
      if (value === "[SYNTHETIC:INTERCEPT]") {
        state.participant.safety_state = "INTERCEPTED";
        event(state, "SYNTHETIC_INTERCEPTED");
        return { state, result: { safety: "INTERCEPTED" } };
      }
      const responseId = crypto.randomUUID();
      state.responses[responseId] = {
        id: responseId,
        letterId: l.id,
        currentRevision: 1,
        status: "ACTIVE",
        revisions: [{ revision: 1, text: value, at: now }],
      };
      l.responseId = responseId;
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
      for (const review of state.reviews)
        if (review.tripId === state.trip.id && review.status !== "DELIVERED")
          review.status = "EXPIRED";
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
        if (l.type === "POSTCARD") {
          l.tripId = state.trip!.id;
          for (const review of state.reviews)
            if (
              review.tripId === state.trip!.id &&
              review.status !== "DELIVERED"
            )
              review.status = "EXPIRED";
        }
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

function invalidate(state: LocalState, responseId: string) {
  for (const review of state.reviews)
    if (
      review.kind === "LINKED" &&
      review.status === "SELECTED" &&
      review.sources.some((e) => e.responseId === responseId)
    ) {
      review.status = "NEEDS_REVIEW";
      review.reason = "来源已更正或删除，请重新核验或选择普通故事。";
    }
}
export async function editResponse(
  id: string,
  responseId: string,
  expectedRevision: number,
  text: string,
  key: string,
) {
  return write<{ message?: string; safety?: string }>(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const r = state.responses[responseId];
    if (!r || r.status !== "ACTIVE")
      throw new LocalError("回应已删除或不存在，请重新载入。");
    const value = text.trim();
    if (!value || value.length > 2000)
      throw new LocalError("请填写 1–2000 字的回应。");
    if (r.lastMutation?.key === key) {
      if (
        r.lastMutation.expectedRevision !== expectedRevision ||
        currentText(r) !== value
      )
        throw new LocalError("请求与已保存的更正不同，请重新载入。");
      return { state, result: { message: "已更正。" } };
    }
    if (r.currentRevision !== expectedRevision)
      throw new LocalError("回应版本已变化，请重新载入后再更正。");
    if (state.participant.safety_state !== "CLEAR")
      throw new LocalError("当前处于独立合成测试路径。");
    if (value === "[SYNTHETIC:UNAVAILABLE]")
      throw new LocalError("合成输入检查不可用，尚未完成更正。");
    if (value === "[SYNTHETIC:INTERCEPT]") {
      state.participant.safety_state = "INTERCEPTED";
      event(state, "SYNTHETIC_INTERCEPTED");
      return { state, result: { safety: "INTERCEPTED" } };
    }
    r.currentRevision++;
    r.revisions.push({
      revision: r.currentRevision,
      text: value,
      at: new Date().toISOString(),
    });
    r.lastMutation = { key, expectedRevision };
    state.letters.find((l) => l.id === r.letterId)!.response = value;
    invalidate(state, r.id);
    state.controlRevision++;
    event(state, "RESPONSE_EDITED");
    return { state, result: { message: "已更正。" } };
  });
}
export async function deleteResponse(
  id: string,
  responseId: string,
  expectedRevision: number,
) {
  return write(
    id,
    (state) => {
      if (!state) throw new LocalError("此本机体验不存在。");
      const r = state.responses[responseId];
      if (!r) throw new LocalError("回应不存在。");
      if (r.currentRevision !== expectedRevision)
        throw new LocalError("回应版本已变化，请重新载入后再删除。");
      if (r.status === "DELETED")
        return { state, result: { message: "已删除。" } };
      r.status = "DELETED";
      for (const v of r.revisions) v.text = null;
      delete r.lastMutation;
      const l = state.letters.find((l) => l.id === r.letterId)!;
      if (l.responseId === responseId) l.response = null;
      invalidate(state, r.id);
      state.controlRevision++;
      event(state, "RESPONSE_DELETED");
      return { state, result: { message: "已删除。" } };
    },
    responseId,
  );
}
export async function selectReview(
  id: string,
  storyId: string,
  sources: Evidence[],
  revision: number,
  key: string,
) {
  return write(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const signature = JSON.stringify([
      "select-review",
      storyId,
      sources,
      revision,
    ]);
    const prior = state.requests[key];
    if (prior) {
      if (prior.signature !== signature)
        throw new LocalError("重复选择与原操作不同。");
      const review = state.reviews.find(
        (r) => r.id === (prior.result as { reviewId: string }).reviewId,
      );
      if (review?.status !== "SELECTED")
        throw new LocalError("这次选择已失效，请重新核验。");
      return { state, result: prior.result };
    }
    if (state.controlRevision !== revision)
      throw new LocalError("体验已更新，请刷新后重新核验来源。");
    if (!state.trip) throw new LocalError("请先独立开始旅行。");
    if (state.participant.safety_state !== "CLEAR")
      throw new LocalError("合成安全路径中不能选取旅行信。");
    if (state.letters.some((l) => l.tripId === state.trip!.id))
      throw new LocalError("这次旅行已经寄过明信片。");
    const story = stories.find((s) => s.id === storyId);
    if (!story) throw new LocalError("请选择冻结旅行故事。");
    for (const e of sources) {
      const r = state.responses[e.responseId];
      const t = r ? currentText(r) : null;
      if (
        !r ||
        r.status !== "ACTIVE" ||
        r.currentRevision !== e.revision ||
        !t ||
        !story.claims.includes(e.claim) ||
        e.start < 0 ||
        e.end > t.length ||
        e.start >= e.end
      )
        throw new LocalError(
          "来源不属于本体验、已失效或范围错误，请重新核验。",
        );
    }
    const compatible = eligible(state, storyId, sources);
    for (const old of state.reviews)
      if (old.tripId === state.trip.id && old.status !== "DELIVERED")
        old.status = "EXPIRED";
    const review: Review = {
      id: crypto.randomUUID(),
      tripId: state.trip.id,
      storyId,
      fallbackId: story.fallback,
      kind: compatible ? "LINKED" : "ORDINARY",
      status: "SELECTED",
      sources,
      reason: compatible
        ? "逐项人工核验通过。"
        : "来源不足、否定、条件或情境不适用，选用完整普通故事。",
    };
    state.reviews.push(review);
    state.controlRevision++;
    event(state, "STORY_SELECTED");
    const result = { reviewId: review.id };
    state.requests[key] = { signature, result };
    return { state, result };
  });
}
export async function deliverReview(id: string, reviewId: string, key: string) {
  return write(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const signature = JSON.stringify(["deliver-review", reviewId]),
      prior = state.requests[key];
    if (prior) {
      if (prior.signature !== signature)
        throw new LocalError("重复请求与原操作不同。");
      return { state, result: prior.result };
    }
    const review = state.reviews.find((r) => r.id === reviewId);
    if (!review || review.status !== "SELECTED")
      throw new LocalError("这次选择已失效，请重新核验或选择普通故事。");
    if (!state.trip || state.trip.id !== review.tripId)
      throw new LocalError("原旅行已经结束，不能补寄。");
    if (state.participant.safety_state !== "CLEAR")
      throw new LocalError("合成安全路径中不能投递。");
    if (state.letters.some((l) => l.tripId === review.tripId))
      throw new LocalError("这次旅行已经寄过明信片。");
    if (
      review.kind === "LINKED" &&
      !eligible(state, review.storyId, review.sources)
    ) {
      review.status = "NEEDS_REVIEW";
      review.reason = "来源已失效，请重新核验。";
      return { state, result: { needsReview: true } };
    }
    const contentId =
        review.kind === "LINKED" ? review.storyId : review.fallbackId,
      c = frozen.items.find((c) => c.id === contentId)!;
    if (state.letters.some((l) => l.id.endsWith(":" + contentId)))
      throw new LocalError("这封故事已经寄过，可选择未寄过的普通故事。");
    const l: Letter = {
      id: `${id}:${contentId}`,
      type: "POSTCARD",
      tripId: review.tripId,
      storyId: contentId,
      read_at: null,
      skipped_at: null,
      delivered_at: new Date().toISOString(),
      response: null,
      snapshot: {
        title: c.title,
        body: c.body,
        catName: state.participant.cat_name!,
        tip: null,
        scene: c.sceneId,
        season: c.narrativeSeason,
        timeOfDay: ("timeOfDay" in c ? c.timeOfDay : null) ?? null,
      },
    };
    if (review.kind === "LINKED")
      l.sourceRefs = structuredClone(review.sources);
    state.letters.unshift(l);
    review.status = "DELIVERED";
    state.controlRevision++;
    event(state, "POSTCARD_DELIVERED");
    const result = { letterId: l.id };
    state.requests[key] = { signature, result };
    return { state, result };
  });
}
