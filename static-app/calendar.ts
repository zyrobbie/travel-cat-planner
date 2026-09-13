import { LocalError, eligible, type LocalState } from "./model";
import { pendingNodes, effectiveTime } from "./calendar-plan";
import { deliverContent, endTrip } from "./delivery";
import { write } from "./database";
export function settleInPlace(state: LocalState, wall = Date.now()): boolean {
  const cal = state.calendar,
    until = effectiveTime(cal, wall),
    due = pendingNodes(cal).filter((n) => n.at <= until);
  if (!due.length) return false;
  for (const n of due) {
    let reason = "已处理",
      letterId: string | undefined,
      outcome: "APPLIED" | "SKIPPED" = "APPLIED";
    try {
      if (n.kind === "START") {
        if (state.trip)
          throw new LocalError("已有旅行，保留原旅行并跳过本次出发。");
        state.trip = { id: n.tripId! };
        state.tripCount++;
        state.events.push({
          event: "TRIP_STARTED",
          at: new Date(wall).toISOString(),
          simulation: true,
        });
      } else if (n.kind === "END") {
        if (state.trip?.id !== n.tripId)
          throw new LocalError("对应旅行已结束或未开始，不影响其他旅行。");
        endTrip(state, wall);
      } else if (n.kind === "DEMAND") {
        letterId = deliverContent(state, n.contentId!, wall, undefined, {
          id: n.id,
          at: n.at,
          effectiveAt: until,
        }).id;
      } else {
        if (state.trip?.id !== n.tripId)
          throw new LocalError("对应旅行当前不在进行。");
        const review = [...state.reviews]
          .reverse()
          .find(
            (r) =>
              r.tripId === n.tripId &&
              r.status === "SELECTED" &&
              r.storyId === `L-${n.scene}`,
          );
        const linked =
          review?.kind === "LINKED" &&
          eligible(state, review.storyId, review.sources) &&
          !state.letters.some(
            (l) => l.id === `${state.participant.id}:${review.storyId}`,
          );
        const contentId = linked ? review.storyId : `O-${n.scene}-01`;
        letterId = deliverContent(
          state,
          contentId,
          wall,
          linked ? review.sources : undefined,
          { id: n.id, at: n.at, effectiveAt: until },
        ).id;
        reason = linked
          ? "有效人工来源联动投递。"
          : "使用同场景普通故事；没有当前可投递的同场景人工联动选择。";
        for (const r of state.reviews)
          if (r.tripId === n.tripId && r.status !== "DELIVERED")
            r.status =
              r.id === review?.id && (linked || review.kind === "ORDINARY")
                ? "DELIVERED"
                : "EXPIRED";
      }
    } catch (e) {
      if (!(e instanceof LocalError)) throw e;
      outcome = "SKIPPED";
      reason = e.message;
    }
    n.result = {
      outcome,
      reason,
      writtenAt: new Date(wall).toISOString(),
      effectiveAt: until,
      ...(letterId ? { letterId } : {}),
    };
    if (n.kind === "POSTCARD" && outcome === "SKIPPED")
      for (const r of state.reviews)
        if (r.tripId === n.tripId && r.status === "SELECTED") {
          r.status = "EXPIRED";
          r.reason = "本次日历来信节点已跳过，不补发。";
        }
    cal.processedCount++;
  }
  cal.lastEffectiveAt = until;
  state.controlRevision++;
  return true;
}
export async function settleCalendar(id: string) {
  return write(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const changed = settleInPlace(state);
    return { state, result: state, changed };
  });
}
export async function fastForward(
  id: string,
  mode: "next" | "end",
  revision: number,
  key: string,
) {
  return write(id, (state) => {
    if (!state) throw new LocalError("此本机体验不存在。");
    const signature = JSON.stringify(["fast-forward", mode, revision]),
      prior = state.requests[key];
    if (prior) {
      if (prior.signature !== signature)
        throw new LocalError("请求与原快进不同。");
      return { state, result: state, changed: false };
    }
    if (state.controlRevision !== revision)
      throw new LocalError("体验已变化，请刷新后确认快进。");
    const nodes = pendingNodes(state.calendar);
    if (!nodes.length)
      throw new LocalError("有限日历已结束，仍可回看和使用人工演示。");
    const wall = Date.now(),
      target = mode === "next" ? nodes[0].at : nodes.at(-1)!.at;
    state.calendar.offsetMs = Math.max(state.calendar.offsetMs, target - wall);
    settleInPlace(state, wall);
    state.requests[key] = { signature, result: { ok: true } };
    return { state, result: state };
  });
}
