import { z } from "zod";

// Browser-safe, deliberately independent of the local database and server.
export const LEGACY_TRANSFER_MAX_BYTES = 4 * 1024 * 1024;
const text = (max: number) =>
  z
    .string()
    .refine(
      (s) =>
        s.length <= max &&
        !s.includes("\0") &&
        Array.from(s).every(
          (ch) =>
            ch.length === 2 ||
            ch.charCodeAt(0) < 0xd800 ||
            ch.charCodeAt(0) > 0xdfff,
        ),
    );
const id = text(1024).refine(
  (s) => s.length > 0 && new TextEncoder().encode(s).byteLength <= 1024,
);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().int().min(0).max(8e15);
const stamp = text(40).refine(
  (s) =>
    Number.isFinite(Date.parse(s)) &&
    Date.parse(s) >= 0 &&
    Date.parse(s) <= 8e15,
);
const scene = z.enum(["RHINE", "FIREFLY", "LIGHTHOUSE"]);
const responseText = text(2000).refine((s) => s.length > 0);
const name = text(1024).refine(
  (s) =>
    s.trim() === s &&
    s.length > 0 &&
    [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(s)]
      .length <= 12 &&
    new TextEncoder().encode(s).byteLength <= 1024,
);
const evidence = z.strictObject({
  claim: z.enum(["rest", "companionship", "care_value", "new_friends"]),
  responseId: id,
  revision: integer.refine((v) => v > 0),
  start: integer.max(2000),
  end: integer.min(1).max(2000),
  assessment: z.enum([
    "SUPPORTED",
    "NEGATED",
    "CONDITION_MISMATCH",
    "UNCERTAIN",
  ]),
  attested: z.boolean(),
});
const snapshot = z.strictObject({
  title: text(1000),
  body: text(20000),
  catName: name,
  tip: text(20000).nullable(),
  scene: text(100).nullable(),
  season: text(100).nullable(),
  timeOfDay: text(100).nullable(),
  contentId: id.optional(),
  contentVersion: id.optional(),
});
const letter = z.strictObject({
  id,
  type: z.enum(["DEMAND", "POSTCARD"]),
  snapshot,
  read_at: stamp.nullable(),
  skipped_at: stamp.nullable(),
  delivered_at: stamp,
  tripId: z.uuid().optional(),
  responseId: id.optional(),
  sourceRefs: z.array(evidence).max(16).optional(),
  storyId: id.optional(),
  calendarNodeId: id.optional(),
  planned_at: stamp.optional(),
  effective_at: stamp.optional(),
});
const response = z.strictObject({
  id,
  letterId: id,
  currentRevision: integer.min(1).max(10000),
  status: z.enum(["ACTIVE", "DELETED"]),
  revisions: z
    .array(
      z.strictObject({
        revision: integer.min(1).max(10000),
        text: responseText.nullable(),
        at: stamp.nullable(),
      }),
    )
    .min(1)
    .max(10000),
});
const review = z.strictObject({
  id,
  tripId: z.uuid(),
  storyId: id,
  fallbackId: id,
  kind: z.enum(["LINKED", "ORDINARY"]),
  status: z.enum(["SELECTED", "NEEDS_REVIEW", "DELIVERED", "EXPIRED"]),
  sources: z.array(evidence).max(16),
  reason: text(1000),
});
const node = z.strictObject({
  id,
  at: time,
  order: integer.max(10000),
  kind: z.enum(["DEMAND", "START", "POSTCARD", "END"]),
  tripId: z.uuid().optional(),
  scene: scene.optional(),
  contentId: id.optional(),
  origin: z.enum(["FIXED", "LEGACY", "MANUAL"]),
  result: z
    .strictObject({
      outcome: z.enum(["APPLIED", "SKIPPED"]),
      reason: text(1000),
      writtenAt: stamp,
      effectiveAt: time,
      letterId: id.optional(),
    })
    .nullable(),
});
export const legacyTransferSchema = z
  .strictObject({
    format: z.literal("cat-letters-legacy"),
    version: z.literal(1),
    sourceNamespace: z.literal("cat-letters-pages-v1"),
    sourceExperienceId: z.uuid(),
    participant: z.strictObject({
      id: z.uuid(),
      cat_name: name,
      appearanceId: z.enum(["cat-01", "cat-02", "cat-03", "cat-04"]),
      status: z.literal("ACTIVE"),
      safety_state: z.enum(["CLEAR", "INTERCEPTED"]),
    }),
    letters: z.array(letter).max(1000),
    responses: z.array(response).max(1000),
    reviews: z.array(review).max(1000),
    calendar: z.strictObject({
      version: z.literal(1),
      initializedAt: time,
      baseAt: time,
      offsetMs: time,
      lastEffectiveAt: time,
      processedCount: integer.max(10000),
      nodes: z.array(node).max(10000),
    }),
    controlRevision: integer.refine(
      (value) => value < Number.MAX_SAFE_INTEGER,
      "旧体验版本号没有安全递增空间，请保留原档并联系维护者。",
    ),
    tripCount: integer,
    trip: z.strictObject({ id: z.uuid() }).nullable(),
  })
  .superRefine((b, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const unique = (rows: { id: string }[]) =>
      new Set(rows.map((r) => r.id)).size === rows.length;
    if (
      b.sourceExperienceId !== b.participant.id ||
      !unique(b.letters) ||
      !unique(b.responses) ||
      !unique(b.reviews) ||
      !unique(b.calendar.nodes)
    )
      fail("重复标识或逻辑小猫归属错误。");
    const letters = new Map(b.letters.map((l) => [l.id, l]));
    const responses = new Map(b.responses.map((r) => [r.id, r]));
    const nodes = new Map(b.calendar.nodes.map((n) => [n.id, n]));
    if (new Set(b.responses.map((r) => r.letterId)).size !== b.responses.length)
      fail("同一封信有多份回应。");
    for (const r of b.responses) {
      const l = letters.get(r.letterId);
      if (!l || l.type !== "DEMAND" || l.responseId !== r.id)
        fail("回应不属于原需求信。");
      const revisions = [...r.revisions].sort(
        (a, c) => a.revision - c.revision,
      );
      if (
        revisions.length !== r.currentRevision ||
        revisions.some((v, i) => v.revision !== i + 1)
      )
        fail("回应版本不连续。");
      if (
        r.status === "DELETED"
          ? r.revisions.some((v) => v.text !== null)
          : r.revisions.some((v) => v.text === null)
      )
        fail("回应墓碑或原文状态不一致。");
    }
    const refs = (items: z.infer<typeof evidence>[]) => {
      for (const s of items) {
        const r = responses.get(s.responseId),
          v = r?.revisions.find((v) => v.revision === s.revision);
        if (
          !r ||
          !v ||
          s.start >= s.end ||
          (v.text !== null && s.end > v.text.length)
        )
          fail("来源版本或 UTF-16 范围错误。");
      }
    };
    for (const l of b.letters) {
      if (!l.id.startsWith(b.sourceExperienceId + ":"))
        fail("信件不属于原小猫。");
      if (l.responseId && responses.get(l.responseId)?.letterId !== l.id)
        fail("回应引用错误。");
      if (
        (l.type === "POSTCARD") !== !!l.tripId ||
        (l.type === "POSTCARD" && (l.responseId || l.skipped_at))
      )
        fail("信件类型与旅行或回应不一致。");
      if (l.sourceRefs?.length && l.type !== "POSTCARD")
        fail("需求信不能含旅行来源。");
      refs(l.sourceRefs ?? []);
      if (l.calendarNodeId) {
        const n = nodes.get(l.calendarNodeId);
        if (!n || n.result?.letterId !== l.id || n.result.outcome !== "APPLIED")
          fail("信件日历引用错误。");
      }
    }
    for (const r of b.reviews) refs(r.sources);
    const c = b.calendar;
    if (
      c.processedCount !== c.nodes.filter((n) => n.result).length ||
      new Set(c.nodes.map((n) => n.order)).size !== c.nodes.length
    )
      fail("日历进度或顺序损坏。");
    for (const n of c.nodes) {
      if (
        n.kind === "DEMAND"
          ? !n.contentId || !!n.tripId || !!n.scene
          : !n.tripId || !n.scene || !!n.contentId
      )
        fail("日历节点形状错误。");
      const result = n.result;
      if (!result) continue;
      if (result.effectiveAt < n.at || result.effectiveAt > c.lastEffectiveAt)
        fail("日历结果时间错误。");
      const shouldHaveLetter =
        result.outcome === "APPLIED" && ["DEMAND", "POSTCARD"].includes(n.kind);
      if (shouldHaveLetter !== !!result.letterId)
        fail("日历结果信件缺失或多余。");
      if (result.letterId) {
        const l = letters.get(result.letterId);
        if (
          !l ||
          l.calendarNodeId !== n.id ||
          (n.kind === "DEMAND"
            ? l.type !== "DEMAND"
            : l.type !== "POSTCARD" || l.tripId !== n.tripId)
        )
          fail("日历结果指向其他信件。");
        if (l?.planned_at && Date.parse(l.planned_at) !== n.at)
          fail("原计划时间不一致。");
        if (
          l?.effective_at &&
          Date.parse(l.effective_at) !== result.effectiveAt
        )
          fail("原有效时间不一致。");
      }
    }
  });
export type LegacyTransfer = z.infer<typeof legacyTransferSchema>;
export function parseLegacyTransfer(value: unknown): LegacyTransfer {
  return legacyTransferSchema.parse(value);
}

// Pick explicit fields, never spread an untrusted local record into an upload.
function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
function pick(value: unknown, keys: string[]) {
  const v = record(value),
    out: Record<string, unknown> = {};
  for (const key of keys) if (v[key] !== undefined) out[key] = v[key];
  return out;
}
const refKeys = [
  "claim",
  "responseId",
  "revision",
  "start",
  "end",
  "assessment",
  "attested",
];
function projectRefs(value: unknown) {
  return z
    .array(z.unknown())
    .parse(value)
    .map((v) => pick(v, refKeys));
}
export function buildLegacyTransfer(value: unknown): LegacyTransfer {
  const s = record(value);
  z.literal(3).parse(s.schema);
  const p = pick(s.participant, [
    "id",
    "cat_name",
    "appearanceId",
    "status",
    "safety_state",
  ]);
  const originalLetters = z.array(z.unknown()).parse(s.letters).map(record);
  const originalResponses = record(s.responses);
  const responses = Object.entries(originalResponses).map(([key, value]) => {
    const r = pick(value, ["id", "letterId", "currentRevision", "status"]);
    if (key !== r.id) throw new Error("本机回应标识不一致，原档未改写。");
    r.revisions = z
      .array(z.unknown())
      .parse(record(value).revisions)
      .map((v) => pick(v, ["revision", "text", "at"]));
    return r;
  });
  const letters = originalLetters.map((l) => {
    const out = pick(l, [
      "id",
      "type",
      "read_at",
      "skipped_at",
      "delivered_at",
      "tripId",
      "responseId",
      "storyId",
      "calendarNodeId",
      "planned_at",
      "effective_at",
    ]);
    out.snapshot = pick(l.snapshot, [
      "title",
      "body",
      "catName",
      "tip",
      "scene",
      "season",
      "timeOfDay",
      "contentId",
      "contentVersion",
    ]);
    if (l.sourceRefs !== undefined) out.sourceRefs = projectRefs(l.sourceRefs);
    return out;
  });
  const cal = record(s.calendar);
  const calendar = pick(cal, [
    "version",
    "initializedAt",
    "baseAt",
    "offsetMs",
    "lastEffectiveAt",
    "processedCount",
  ]);
  calendar.nodes = z
    .array(z.unknown())
    .parse(cal.nodes)
    .map((value) => {
      const n = record(value),
        out = pick(n, [
          "id",
          "at",
          "order",
          "kind",
          "tripId",
          "scene",
          "contentId",
          "origin",
        ]);
      out.result =
        n.result === null
          ? null
          : pick(n.result, [
              "outcome",
              "reason",
              "writtenAt",
              "effectiveAt",
              "letterId",
            ]);
      return out;
    });
  const bundle = parseLegacyTransfer({
    format: "cat-letters-legacy",
    version: 1,
    sourceNamespace: "cat-letters-pages-v1",
    sourceExperienceId: p.id,
    participant: p,
    letters,
    responses,
    calendar,
    reviews: z
      .array(z.unknown())
      .parse(s.reviews)
      .map((value) => {
        const r = pick(value, [
          "id",
          "tripId",
          "storyId",
          "fallbackId",
          "kind",
          "status",
          "reason",
        ]);
        r.sources = projectRefs(record(value).sources);
        return r;
      }),
    controlRevision: s.controlRevision,
    tripCount: s.tripCount,
    trip: s.trip === null ? null : pick(s.trip, ["id"]),
  });
  // The omitted letter.response is a projection, but a disagreement is corruption.
  for (const l of originalLetters) {
    const r = bundle.responses.find((r) => r.id === l.responseId);
    const expected =
      r?.status === "ACTIVE"
        ? r.revisions.find((v) => v.revision === r.currentRevision)!.text
        : null;
    if (l.response !== expected)
      throw new Error("本机回应投影与版本记录不同，原档未改写。");
  }
  if (
    new TextEncoder().encode(JSON.stringify(bundle)).byteLength >
    LEGACY_TRANSFER_MAX_BYTES - 1024
  )
    throw new Error("这份体验超过单次转移大小上限，请保留原档并联系维护者。");
  return bundle;
}
