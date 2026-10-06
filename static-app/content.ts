import frozen from "../src/content/frozen.json";

// Published light-chasing copy from the accepted seven-demand preview.
// Natural delivery is intentionally not scheduled until the calendar decision.
export const LIGHT_DEMAND = Object.freeze({
  id: "D-07",
  version: "e3-light-20261005-v1",
  type: "DEMAND" as const,
  title: "阳光会在这里等我吗？",
  body: "窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？",
  tip: "可以说说你今天看见的一点小事，也可以只写一句话。\n这次不想回，也没关系。",
  sceneId: null,
  narrativeSeason: null,
  timeOfDay: null,
});

export const MANUAL_DEMAND_IDS = Object.freeze([
  "D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07",
]);
export const contentById = (id: string) =>
  frozen.items.find((item) => item.id === id) ?? (id === LIGHT_DEMAND.id ? LIGHT_DEMAND : undefined);
