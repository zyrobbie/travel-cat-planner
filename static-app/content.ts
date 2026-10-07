import frozen from "../src/content/frozen.json";
import { LIGHT_DEMAND } from "../src/content/supplemental";
export { LIGHT_DEMAND } from "../src/content/supplemental";

export const MANUAL_DEMAND_IDS = Object.freeze([
  "D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07",
]);
export const contentById = (id: string) =>
  frozen.items.find((item) => item.id === id) ?? (id === LIGHT_DEMAND.id ? LIGHT_DEMAND : undefined);
