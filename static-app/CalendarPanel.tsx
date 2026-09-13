import { useRef } from "react";
import type { LocalState } from "./model";
import { fastForward } from "./store";
import { pendingNodes, effectiveTime } from "./calendar-plan";
import s from "../src/app/page.module.css";
export default function CalendarPanel({
  state,
  busy,
  perform,
}: {
  state: LocalState;
  busy: boolean;
  perform: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const request = useRef<{
      mode: string;
      revision: number;
      key: string;
    } | null>(null),
    next = pendingNodes(state.calendar)[0];
  function advance(mode: "next" | "end") {
    return perform(() => {
      if (
        request.current?.mode !== mode ||
        request.current.revision !== state.controlRevision
      )
        request.current = {
          mode,
          revision: state.controlRevision,
          key: crypto.randomUUID(),
        };
      return fastForward(
        state.participant.id,
        mode,
        request.current.revision,
        request.current.key,
      );
    });
  }
  return (
    <section>
      <h2>本机日历与演示快进</h2>
      <p className={s.meta}>
        关闭网页只是离开，小猫的日历继续。关闭期间没有后台执行；打开、返回前台或页面可见时才结算。最多留一封未读信，读完即可，不要求回复。
      </p>
      <p className={s.meta}>
        固定工程日历为 14 日；第一节点在初始化后 24
        小时。演示快进只调整这只猫的本机时间偏移，刷新后保留，不修改系统时钟。
      </p>
      <p>
        当前{state.calendar.offsetMs ? "演示" : "本机"}日历时间：
        {new Date(effectiveTime(state.calendar, Date.now())).toLocaleString(
          "zh-CN",
        )}
      </p>
      <p className={s.meta}>
        {next
          ? `下一节点：${new Date(next.at).toLocaleString("zh-CN")}`
          : "有限日历已结束。仍可回看与使用人工演示，不循环重寄。"}
      </p>
      <div className={s.inline}>
        <button disabled={busy || !next} onClick={() => advance("next")}>
          演示快进到下一节点
        </button>
        <button disabled={busy || !next} onClick={() => advance("end")}>
          演示快进到日历末尾
        </button>
      </div>
      <details>
        <summary>日历工程记录</summary>
        {state.calendar.nodes.map((n) => (
          <p className={s.meta} key={n.id}>
            {n.id} · 计划 {new Date(n.at).toLocaleString("zh-CN")} ·{" "}
            {n.result
              ? `${n.result.outcome} / ${n.result.reason} / 实际写入 ${new Date(n.result.writtenAt).toLocaleString("zh-CN")}`
              : "尚未结算"}
          </p>
        ))}
      </details>
    </section>
  );
}
