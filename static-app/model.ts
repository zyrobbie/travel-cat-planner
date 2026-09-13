import { z } from "zod";
import {
  calendarSchema,
  initializeCalendar,
  type Calendar,
} from "./calendar-plan";
import type {
  AppState as PreviousAppState,
  Letter as PreviousLetter,
} from "../src/app/client-api";
export class LocalError extends Error {}
export type Claim = "rest" | "companionship" | "care_value" | "new_friends";
export const stories = [
  {
    id: "L-RHINE",
    title: "我走了另一条路",
    fallback: "O-RHINE-01",
    claims: ["rest"] as Claim[],
  },
  {
    id: "L-FIREFLY",
    title: "抱抱也是礼物",
    fallback: "O-FIREFLY-01",
    claims: ["companionship", "care_value"] as Claim[],
  },
  {
    id: "L-LIGHTHOUSE",
    title: "灯塔亮起来的时候",
    fallback: "O-LIGHTHOUSE-01",
    claims: ["new_friends"] as Claim[],
  },
];
export const claimLabels: Record<Claim, string> = {
  rest: "允许累时休息，条件适用于这次山路情境",
  companionship: "陪伴可以表达关心",
  care_value: "心意本身具有礼物的价值",
  new_friends: "面对新伙伴可以先观察、慢慢来",
};
export type Evidence = {
  claim: Claim;
  responseId: string;
  revision: number;
  start: number;
  end: number;
  assessment: "SUPPORTED" | "NEGATED" | "CONDITION_MISMATCH" | "UNCERTAIN";
  attested: boolean;
};
export type ResponseRecord = {
  id: string;
  letterId: string;
  currentRevision: number;
  status: "ACTIVE" | "DELETED";
  lastMutation?: { key: string; expectedRevision: number };
  revisions: { revision: number; text: string | null; at: string | null }[];
};
export type Review = {
  id: string;
  tripId: string;
  storyId: string;
  fallbackId: string;
  kind: "LINKED" | "ORDINARY";
  status: "SELECTED" | "NEEDS_REVIEW" | "DELIVERED" | "EXPIRED";
  sources: Evidence[];
  reason: string;
};
export type Letter = PreviousLetter & {
  tripId?: string;
  responseId?: string;
  sourceRefs?: Evidence[];
  storyId?: string;
};
export type Draft = {
  kind: "reply" | "edit";
  text: string;
  responseId: string | null;
  revision: number | null;
  updatedAt: string;
};
export type LocalState = Omit<PreviousAppState, "letters"> & {
  schema: 3;
  calendar: Calendar;
  drafts: Record<string, Draft>;
  letters: Letter[];
  controlRevision: number;
  tripCount: number;
  events: { event: string; at: string; simulation: true }[];
  requests: Record<string, { signature: string; result: unknown }>;
  responses: Record<string, ResponseRecord>;
  reviews: Review[];
};
export type AppState = LocalState;
const stamp = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const letterSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["DEMAND", "POSTCARD"]),
    read_at: stamp.nullable(),
    skipped_at: stamp.nullable(),
    delivered_at: stamp,
    response: z.string().min(1).max(2000).nullable(),
    snapshot: z
      .object({
        title: z.string(),
        body: z.string(),
        catName: z.string(),
        tip: z.string().nullable(),
        scene: z.string().nullable(),
        season: z.string().nullable(),
        timeOfDay: z.string().nullable(),
      })
      .passthrough(),
    tripId: z.string().optional(),
  })
  .passthrough();
const base = z
  .object({
    schema: z.number(),
    participant: z
      .object({
        id: z.string().uuid(),
        cat_name: z.string().min(1).max(12),
        status: z.literal("ACTIVE"),
        safety_state: z.enum(["CLEAR", "INTERCEPTED"]),
      })
      .passthrough(),
    trip: z.object({ id: z.string().uuid() }).passthrough().nullable(),
    letters: z.array(letterSchema),
    controlRevision: z.number().int().nonnegative(),
    tripCount: z.number().int().nonnegative(),
    events: z.array(
      z
        .object({ event: z.string(), at: stamp, simulation: z.literal(true) })
        .passthrough(),
    ),
    requests: z.record(
      z.string(),
      z.object({ signature: z.string(), result: z.unknown() }),
    ),
  })
  .passthrough();
const evidence = z.object({
  claim: z.enum(["rest", "companionship", "care_value", "new_friends"]),
  responseId: z.string(),
  revision: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  assessment: z.enum([
    "SUPPORTED",
    "NEGATED",
    "CONDITION_MISMATCH",
    "UNCERTAIN",
  ]),
  attested: z.boolean(),
});
const response = z.object({
  id: z.string(),
  letterId: z.string(),
  currentRevision: z.number().int().positive(),
  status: z.enum(["ACTIVE", "DELETED"]),
  lastMutation: z
    .object({ key: z.string(), expectedRevision: z.number().int().positive() })
    .optional(),
  revisions: z
    .array(
      z.object({
        revision: z.number().int().positive(),
        text: z.string().min(1).max(2000).nullable(),
        at: stamp.nullable(),
      }),
    )
    .min(1),
});
const second = base.extend({
  schema: z.literal(2),
  responses: z.record(z.string(), response),
  reviews: z.array(
    z.object({
      id: z.string(),
      tripId: z.string(),
      storyId: z.string(),
      fallbackId: z.string(),
      kind: z.enum(["LINKED", "ORDINARY"]),
      status: z.enum(["SELECTED", "NEEDS_REVIEW", "DELIVERED", "EXPIRED"]),
      sources: z.array(evidence),
      reason: z.string(),
    }),
  ),
  letters: z.array(
    letterSchema.extend({
      responseId: z.string().optional(),
      sourceRefs: z.array(evidence).optional(),
      storyId: z.string().optional(),
    }),
  ),
});
/** Pure conversion. No fallback to blank participants; caller commits all records in one upgrade transaction. */
export function migrateRecord(value: unknown, now = Date.now()): LocalState {
  try {
    const old = base.parse(value);
    if (old.schema !== 1 && old.schema !== 2 && old.schema !== 3)
      throw Error("unknown schema");
    if (new Set(old.letters.map((l) => l.id)).size !== old.letters.length)
      throw Error("duplicate letters");
    if (
      old.letters.some(
        (l) =>
          !l.id.startsWith(old.participant.id + ":") ||
          (l.type === "POSTCARD" && l.response !== null),
      )
    )
      throw Error("letter ownership");
    let result: LocalState;
    if (old.schema === 1) {
      const responses: Record<string, ResponseRecord> = {};
      const letters = old.letters.map((l) => {
        if (l.response === null) return l;
        const id = `${l.id}:response-v1`;
        responses[id] = {
          id,
          letterId: l.id,
          currentRevision: 1,
          status: "ACTIVE",
          revisions: [{ revision: 1, text: l.response, at: null }],
        };
        return { ...l, responseId: id };
      });
      result = {
        ...old,
        schema: 2,
        letters,
        responses,
        reviews: [],
      } as unknown as LocalState;
    } else
      result = second.parse({ ...old, schema: 2 }) as unknown as LocalState;
    for (const [id, r] of Object.entries(result.responses)) {
      if (
        id !== r.id ||
        !result.letters.some(
          (l) => l.id === r.letterId && l.type === "DEMAND",
        ) ||
        new Set(r.revisions.map((v) => v.revision)).size !==
          r.revisions.length ||
        !r.revisions.some((v) => v.revision === r.currentRevision)
      )
        throw Error("response reference");
      if (
        r.status === "ACTIVE" &&
        (!result.letters.some(
          (l) => l.id === r.letterId && l.responseId === r.id,
        ) ||
          typeof r.revisions.find((v) => v.revision === r.currentRevision)
            ?.text !== "string")
      )
        throw Error("orphan active response");
      if (r.status === "DELETED" && r.revisions.some((v) => v.text !== null))
        throw Error("deleted text remains");
    }
    for (const l of result.letters) {
      if (l.responseId) {
        const r = result.responses[l.responseId];
        if (
          !r ||
          r.letterId !== l.id ||
          l.response !==
            (r.status === "ACTIVE"
              ? r.revisions.find((v) => v.revision === r.currentRevision)!.text
              : null)
        )
          throw Error("response projection");
      } else if (l.response !== null) throw Error("missing response");
    }
    for (const refs of [
      ...result.letters.map((l) => l.sourceRefs ?? []),
      ...result.reviews.map((r) => r.sources),
    ])
      for (const ref of refs) {
        if (
          !result.responses[ref.responseId]?.revisions.some(
            (v) => v.revision === ref.revision,
          )
        )
          throw Error("invalid source reference");
      }
    if (old.schema === 3) {
      result.drafts = z
        .record(
          z.string(),
          z.object({
            kind: z.enum(["reply", "edit"]),
            text: z.string().max(2000),
            responseId: z.string().nullable(),
            revision: z.number().int().positive().nullable(),
            updatedAt: stamp,
          }),
        )
        .parse(old.drafts);
      for (const [id, d] of Object.entries(result.drafts)) {
        const l = result.letters.find(
          (l) => l.id === id && l.type === "DEMAND",
        );
        if (
          !l ||
          (l.responseId ?? null) !== d.responseId ||
          (d.kind === "reply" && l.response !== null) ||
          (d.kind === "edit" &&
            (!d.responseId ||
              result.responses[d.responseId]?.status !== "ACTIVE" ||
              result.responses[d.responseId]?.currentRevision !== d.revision))
        )
          throw Error("invalid draft");
      }
      result.calendar = calendarSchema.parse(old.calendar);
      if (
        new Set(result.calendar.nodes.map((n) => n.id)).size !==
          result.calendar.nodes.length ||
        new Set(result.calendar.nodes.map((n) => n.order)).size !==
          result.calendar.nodes.length ||
        result.calendar.processedCount !==
          result.calendar.nodes.filter((n) => n.result).length
      )
        throw Error("invalid calendar progress");
      for (const n of result.calendar.nodes) {
        if (n.kind === "DEMAND" ? !n.contentId : !n.tripId || !n.scene)
          throw Error("invalid calendar node");
      }
    } else {
      result.calendar = initializeCalendar(result, now);
      result.drafts = {};
    }
    result.schema = 3;
    return result;
  } catch {
    throw new LocalError(
      "本机数据版本未知或记录损坏，原数据未改写。请保留此浏览器数据并联系维护者，不要清空或重建体验。",
    );
  }
}
export function currentText(r: ResponseRecord) {
  return r.status === "ACTIVE"
    ? (r.revisions.find((v) => v.revision === r.currentRevision)?.text ?? null)
    : null;
}
export function eligible(
  state: LocalState,
  storyId: string,
  sources: Evidence[],
): boolean {
  const story = stories.find((s) => s.id === storyId);
  if (!story || sources.length !== story.claims.length) return false;
  return story.claims.every((claim) => {
    const matches = sources.filter((s) => s.claim === claim);
    if (matches.length !== 1) return false;
    const e = matches[0],
      r = state.responses[e.responseId],
      text = r ? currentText(r) : null;
    return (
      !!r &&
      r.currentRevision === e.revision &&
      typeof text === "string" &&
      e.start >= 0 &&
      e.end <= text.length &&
      e.end > e.start &&
      e.assessment === "SUPPORTED" &&
      e.attested === true
    );
  });
}
