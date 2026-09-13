import frozen from "../src/content/frozen.json";
import {
  LocalError,
  type LocalState,
  type Evidence,
  type Letter,
} from "./model";
export const unreadCount = (state: LocalState) =>
  state.letters.filter((l) => !l.read_at).length;
export function assertVacancy(state: LocalState) {
  if (unreadCount(state) > 0)
    throw new LocalError("还有未读来信，请先打开阅读；不需要回复。");
}
export function deliverContent(
  state: LocalState,
  contentId: string,
  actualAt: number,
  sourceRefs?: Evidence[],
  node?: { id: string; at: number; effectiveAt: number },
) {
  assertVacancy(state);
  if (state.participant.safety_state !== "CLEAR")
    throw new LocalError("合成安全路径中不能投递。");
  const c = frozen.items.find((c) => c.id === contentId);
  if (!c || !["DEMAND", "ORDINARY", "LINKED"].includes(c.type))
    throw new LocalError("没有可用的冻结正文。");
  if (
    state.letters.some((l) => l.id === `${state.participant.id}:${contentId}`)
  )
    throw new LocalError("这封故事已经寄过。");
  if (c.type === "DEMAND" && state.trip)
    throw new LocalError("旅行中不投递日常卡。");
  if (c.type !== "DEMAND") {
    if (!state.trip) throw new LocalError("请先独立开始旅行。");
    if (
      state.letters.some(
        (l) => l.type === "POSTCARD" && l.tripId === state.trip!.id,
      )
    )
      throw new LocalError("这次旅行已经寄过明信片。");
  }
  const l: Letter = {
    id: `${state.participant.id}:${c.id}`,
    type: c.type === "DEMAND" ? "DEMAND" : "POSTCARD",
    read_at: null,
    skipped_at: null,
    delivered_at: new Date(actualAt).toISOString(),
    response: null,
    snapshot: {
      title: c.title,
      body: c.body,
      catName: state.participant.cat_name!,
      tip:
        frozen.items.find((t) => t.id === c.id.replace("D-", "TIPS-"))?.body ??
        null,
      scene: c.sceneId,
      season: c.narrativeSeason,
      timeOfDay: ("timeOfDay" in c ? c.timeOfDay : null) ?? null,
    },
  };
  if (l.type === "POSTCARD") {
    l.tripId = state.trip!.id;
    l.storyId = contentId;
  }
  if (sourceRefs) l.sourceRefs = structuredClone(sourceRefs);
  if (node)
    Object.assign(l, {
      calendarNodeId: node.id,
      planned_at: new Date(node.at).toISOString(),
      effective_at: new Date(node.effectiveAt).toISOString(),
    });
  state.letters.unshift(l);
  state.events.push({
    event: l.type === "DEMAND" ? "DEMAND_DELIVERED" : "POSTCARD_DELIVERED",
    at: new Date(actualAt).toISOString(),
    simulation: true,
  });
  return l;
}
export function endTrip(state: LocalState, at: number) {
  if (!state.trip) return;
  for (const r of state.reviews)
    if (r.tripId === state.trip.id && r.status !== "DELIVERED")
      r.status = "EXPIRED";
  state.trip = null;
  state.events.push({
    event: "TRIP_ENDED",
    at: new Date(at).toISOString(),
    simulation: true,
  });
}
