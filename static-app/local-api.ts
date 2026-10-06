import {
  readState,
  createParticipant,
  letterAction,
  LocalError,
} from "./store";
import { isAppearanceId } from "./model";
export type { AppState, Letter } from "./model";
export const selectedId = () => location.hash.slice(1);
export async function api(path: string, body?: Record<string, unknown>) {
  const id = selectedId();
  if (path === "state") return id ? readState(id) : null;
  if (path === "start") {
    if (!isAppearanceId(body?.appearanceId))
      throw new LocalError("请先选择一只小猫的外观。");
    const state = await createParticipant(String(body?.name ?? ""), body.appearanceId);
    history.replaceState(null, "", `#${state.participant.id}`);
    return { ok: true };
  }
  const match = path.match(/^letters\/(.+)\/(read|skip|respond)$/);
  if (match)
    return letterAction(
      id,
      match[1],
      match[2] as "read" | "skip" | "respond",
      String(body?.text ?? ""),
      typeof body?.expectedResponseId === "string"
        ? body.expectedResponseId
        : null,
    );
  throw new LocalError("此本机操作不存在。");
}
