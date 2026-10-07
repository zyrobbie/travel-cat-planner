import { readState } from "./database";
import { selectedId } from "./local-api";
import { buildLegacyTransfer } from "../src/shared/legacy-transfer";

export async function exportSelectedCat() {
  const id = selectedId();
  if (!id) throw new Error("请先打开要导出的小猫。");
  // Only the explicitly opened cat is read; no enumeration or upload occurs here.
  const selected = await readState(id);
  if (selectedId() !== id) throw new Error("已切换小猫，请重新选择导出。");
  const bundle = buildLegacyTransfer(selected);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cat-letters-${id}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
