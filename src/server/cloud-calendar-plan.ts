import { randomInt, randomUUID } from "node:crypto";

export const DAY_MS = 86_400_000;
export const WELCOME_MIN_DELAY_MS = 300_000;
export const WELCOME_MAX_DELAY_MS = 600_000;
export type CloudScene = "RHINE" | "FIREFLY" | "LIGHTHOUSE";
export type CloudNodeKind = "DEMAND" | "START" | "POSTCARD" | "END";
export interface CloudPlanNode {
  id: string;
  plannedAt: number;
  order: number;
  kind: CloudNodeKind;
  contentId: string | null;
  tripId: string | null;
  scene: CloudScene | null;
}
export function newCloudCalendarPlan(nowMs: number): CloudPlanNode[] {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8e15 - 14 * DAY_MS)
    throw new Error("Invalid calendar base time");
  const first = randomUUID(),
    second = randomUUID();
  const schedule: [
    number,
    CloudNodeKind,
    string | null,
    string | null,
    CloudScene | null,
  ][] = [
    [1, "DEMAND", "D-03", null, null],
    [3, "DEMAND", "D-04", null, null],
    [5, "DEMAND", "D-02", null, null],
    [6, "START", null, first, "FIREFLY"],
    [7, "POSTCARD", null, first, "FIREFLY"],
    [8, "END", null, first, "FIREFLY"],
    [9, "DEMAND", "D-05", null, null],
    [10, "DEMAND", "D-01", null, null],
    [11, "DEMAND", "D-06", null, null],
    [12, "START", null, second, "LIGHTHOUSE"],
    [13, "POSTCARD", null, second, "LIGHTHOUSE"],
    [14, "END", null, second, "LIGHTHOUSE"],
  ];
  const nodes = schedule.map(
    ([day, kind, contentId, tripId, scene], order) => ({
      id: `fixed:d${day}`,
      plannedAt: nowMs + day * DAY_MS,
      order,
      kind,
      contentId,
      tripId,
      scene,
    }),
  );
  nodes.push({
    id: "welcome:d0",
    plannedAt:
      nowMs + randomInt(WELCOME_MIN_DELAY_MS, WELCOME_MAX_DELAY_MS + 1),
    order: nodes.length,
    kind: "DEMAND",
    contentId: "D-07",
    tripId: null,
    scene: null,
  });
  return nodes;
}
