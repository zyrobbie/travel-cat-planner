import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import frozen from "../content/frozen.json";
import { LIGHT_DEMAND } from "../content/supplemental";

export type CloudContentItem = Readonly<{
  id: string;
  version: string;
  type: "DEMAND" | "ORDINARY" | "LINKED";
  title: string;
  body: string;
  [key: string]: unknown;
}>;

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

// jsonb does not retain object key order; arrays, string contents and every
// payload field do participate in this deterministic full-payload checksum.
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Content payload must contain only JSON values");
}

export function cloudContentHash(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

export function cloudBodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

// Copy complete approved payloads. In particular, linked requirements and their
// ordinary fallback IDs are not reconstructed from a shortened letter body.
export const cloudContentItems: readonly CloudContentItem[] = freezeJson([
  ...frozen.items
    .filter((item) => ["DEMAND", "ORDINARY", "LINKED"].includes(item.type))
    .map((item) => structuredClone(item) as CloudContentItem),
  LIGHT_DEMAND,
]);

const expectedCounts = { DEMAND: 7, ORDINARY: 3, LINKED: 3 };
for (const [type, expected] of Object.entries(expectedCounts)) {
  if (
    cloudContentItems.filter((item) => item.type === type).length !== expected
  )
    throw new Error(`Unexpected cloud content count: ${type}`);
}
if (
  new Set(cloudContentItems.map((item) => `${item.id}\0${item.version}`))
    .size !== cloudContentItems.length
)
  throw new Error("Duplicate cloud content version");

export const cloudContentManifest = freezeJson({
  count: cloudContentItems.length,
  items: cloudContentItems.map((item) => {
    const bodySha256 = cloudBodyHash(item.body);
    if ("sha256" in item && item.sha256 !== bodySha256)
      throw new Error(`Frozen body checksum differs: ${item.id}`);
    return {
      contentId: item.id,
      version: item.version,
      bodySha256,
      payloadSha256: cloudContentHash(item),
    };
  }),
});

export function getCloudContent(id: string, version?: string) {
  return cloudContentItems.find(
    (item) =>
      item.id === id && (version === undefined || item.version === version),
  );
}

// Callers supplying a client must already own a transaction. The no-argument
// path owns one transaction so a later collision cannot leave partial seeding.
export async function registerCloudContent(
  db?: PoolClient,
): Promise<typeof cloudContentManifest> {
  if (!db) {
    const { transaction } = await import("./db");
    return transaction((client) => registerCloudContent(client));
  }
  for (const [index, item] of cloudContentItems.entries()) {
    const expected = cloudContentManifest.items[index];
    await db.query(
      `INSERT INTO cloud_content_versions
        (content_id,version,type,payload,body_checksum,payload_checksum)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(content_id,version) DO NOTHING`,
      [
        item.id,
        item.version,
        item.type,
        item,
        expected.bodySha256,
        expected.payloadSha256,
      ],
    );
    const result = await db.query(
      `SELECT type,payload,body_checksum,payload_checksum
       FROM cloud_content_versions WHERE content_id=$1 AND version=$2 FOR SHARE`,
      [item.id, item.version],
    );
    const existing = result.rows[0];
    if (
      !existing ||
      existing.type !== item.type ||
      existing.body_checksum !== expected.bodySha256 ||
      existing.payload_checksum !== expected.payloadSha256 ||
      !existing.payload ||
      typeof existing.payload.body !== "string" ||
      cloudBodyHash(existing.payload.body) !== expected.bodySha256 ||
      cloudContentHash(existing.payload) !== expected.payloadSha256
    )
      throw new Error(
        `Cloud content version collision: ${item.id}@${item.version}`,
      );
  }
  return cloudContentManifest;
}
