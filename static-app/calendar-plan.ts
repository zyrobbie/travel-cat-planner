import { z } from "zod";
export const DAY = 86_400_000;
export type Scene = "RHINE" | "FIREFLY" | "LIGHTHOUSE";
const time = z.number().int().nonnegative().max(8_000_000_000_000_000);
export const calendarSchema = z.object({
  version: z.literal(1),
  initializedAt: time,
  baseAt: time,
  offsetMs: time,
  lastEffectiveAt: time,
  processedCount: z.number().int().nonnegative(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        at: time,
        order: z.number().int().nonnegative(),
        kind: z.enum(["DEMAND", "START", "POSTCARD", "END"]),
        tripId: z.string().uuid().optional(),
        scene: z.enum(["RHINE", "FIREFLY", "LIGHTHOUSE"]).optional(),
        contentId: z.string().optional(),
        origin: z.enum(["FIXED", "LEGACY", "MANUAL"]),
        result: z
          .object({
            outcome: z.enum(["APPLIED", "SKIPPED"]),
            reason: z.string(),
            writtenAt: z.string().datetime(),
            effectiveAt: time,
            letterId: z.string().optional(),
          })
          .nullable(),
      }),
    )
    .max(10000),
});
export type Calendar = z.infer<typeof calendarSchema>;
export type CalendarNode = Calendar["nodes"][number];
type Legacy = {
  trip: { id: string } | null;
  letters: {
    type: string;
    tripId?: string;
    snapshot: { scene: string | null };
  }[];
  reviews: { tripId: string; status: string; storyId: string }[];
};
export function initializeCalendar(state: Legacy, now: number): Calendar {
  const cal: Calendar = {
    version: 1,
    initializedAt: now,
    baseAt: now,
    offsetMs: 0,
    lastEffectiveAt: now,
    processedCount: 0,
    nodes: [],
  };
  if (state.trip) {
    const chosen = [...state.reviews]
      .reverse()
      .find(
        (r) =>
          r.tripId === state.trip!.id &&
          ["SELECTED", "NEEDS_REVIEW"].includes(r.status),
      );
    const sent = state.letters.find(
      (l) => l.type === "POSTCARD" && l.tripId === state.trip!.id,
    );
    const scene = (chosen?.storyId.replace("L-", "") ||
      sent?.snapshot.scene ||
      "RHINE") as Scene;
    appendTrip(
      cal,
      state.trip.id,
      ["RHINE", "FIREFLY", "LIGHTHOUSE"].includes(scene) ? scene : "RHINE",
      now,
      "LEGACY",
    );
    cal.baseAt = now + 2 * DAY;
  }
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const schedule: [number, CalendarNode["kind"], string?, string?, Scene?][] = [
    [1, "DEMAND", "D-03"],
    [3, "DEMAND", "D-04"],
    [5, "DEMAND", "D-02"],
    [6, "START", undefined, first, "FIREFLY"],
    [7, "POSTCARD", undefined, first, "FIREFLY"],
    [8, "END", undefined, first, "FIREFLY"],
    [9, "DEMAND", "D-05"],
    [10, "DEMAND", "D-01"],
    [11, "DEMAND", "D-06"],
    [12, "START", undefined, second, "LIGHTHOUSE"],
    [13, "POSTCARD", undefined, second, "LIGHTHOUSE"],
    [14, "END", undefined, second, "LIGHTHOUSE"],
  ];
  for (const [day, kind, contentId, tripId, scene] of schedule)
    cal.nodes.push({
      id: `fixed:d${day}`,
      at: cal.baseAt + day * DAY,
      order: cal.nodes.length,
      kind,
      contentId,
      tripId,
      scene,
      origin: "FIXED",
      result: null,
    });
  return cal;
}
export function appendTrip(
  cal: Calendar,
  tripId: string,
  scene: Scene,
  at: number,
  origin: "LEGACY" | "MANUAL",
) {
  for (const [days, kind] of [
    [1, "POSTCARD"],
    [2, "END"],
  ] as const)
    cal.nodes.push({
      id: `${origin.toLowerCase()}:${tripId}:${kind}`,
      at: at + days * DAY,
      order: cal.nodes.length,
      kind,
      tripId,
      scene,
      origin,
      result: null,
    });
}
export const effectiveTime = (cal: Calendar, wall: number) =>
  Math.max(cal.lastEffectiveAt, wall + cal.offsetMs);
export const pendingNodes = (cal: Calendar) =>
  cal.nodes
    .filter((n) => !n.result)
    .sort((a, b) => a.at - b.at || a.order - b.order);
