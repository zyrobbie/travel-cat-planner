/// <reference types="vite/client" />
import type { AppearanceId } from "./model";

// Vite emits immutable WebP URLs. The browser fetches only the active scene.
const daily = import.meta.glob("../ui-daily-core-v1/assets/web/**/*.webp", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;
const cats = import.meta.glob("../ui-components-v1/assets/web/*.webp", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

function from(map: Record<string, string>, root: string, file: string): string {
  const found = map[`${root}/${file}`];
  if (!found) throw new Error(`Missing approved image: ${file}`);
  return found;
}
export const dailyImage = (file: string) =>
  from(daily, "../ui-daily-core-v1/assets/web", file);
export const catImage = (file: string) =>
  from(cats, "../ui-components-v1/assets/web", file);

export function responsiveDaily(stem: string) {
  return {
    src: dailyImage(`${stem}-600.webp`),
    srcSet: `${dailyImage(`${stem}-600.webp`)} 600w, ${dailyImage(`${stem}-1200.webp`)} 1200w`,
  };
}
export function responsiveCat(id: AppearanceId) {
  return {
    src: catImage(`${id}-320.webp`),
    srcSet: `${catImage(`${id}-320.webp`)} 320w, ${catImage(`${id}-640.webp`)} 640w`,
  };
}
const EVENT_STEMS: Record<string, string> = {
  "D-07": "need-window",
  "D-01": "demand-D01",
  "D-02": "demand-D02",
  "D-03": "demand-D03",
  "D-04": "demand-D04",
  "D-05": "demand-D05",
  "D-06": "demand-D06",
};
export const eventImage = (contentId: string, id: AppearanceId) => {
  const stem = EVENT_STEMS[contentId];
  return stem ? responsiveDaily(`${stem}-${id}`) : null;
};
export const postcardImage = (scene: string | null, id: AppearanceId) =>
  scene && ["RHINE", "FIREFLY", "LIGHTHOUSE"].includes(scene)
    ? responsiveDaily(`postcard-${scene.toLowerCase()}-${id}`)
    : null;
export const approvedEventIds = Object.freeze(Object.keys(EVENT_STEMS));
