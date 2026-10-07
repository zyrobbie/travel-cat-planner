import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import frozen from "../../src/content/frozen.json";
import { LIGHT_DEMAND as sharedLight } from "../../src/content/supplemental";
import {
  LIGHT_DEMAND as frontendLight,
  contentById,
} from "../../static-app/content";
import {
  cloudBodyHash,
  cloudContentHash,
  cloudContentItems,
  cloudContentManifest,
  getCloudContent,
} from "../../src/server/cloud-content";

test("cloud registry preserves all approved demand and complete travel payloads", () => {
  assert.equal(cloudContentManifest.count, 13);
  assert.deepEqual(
    cloudContentItems
      .filter((item) => item.type === "DEMAND")
      .map((item) => item.id)
      .sort(),
    ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07"],
  );
  for (const item of frozen.items.filter((item) =>
    ["DEMAND", "ORDINARY", "LINKED"].includes(item.type),
  )) {
    assert.deepEqual(getCloudContent(item.id, item.version), item);
    assert.equal(cloudBodyHash(item.body), item.sha256);
    if (item.type === "LINKED") {
      assert.ok(item.claimRequirements.length);
      assert.equal(getCloudContent(item.ordinaryFallbackId!)?.type, "ORDINARY");
    }
  }
  assert.equal(getCloudContent("D-03", "unregistered-version"), undefined);
});

test("D07 frontend and cloud use one unchanged approved payload", () => {
  assert.equal(frontendLight, sharedLight);
  assert.equal(contentById("D-07"), sharedLight);
  assert.equal(getCloudContent("D-07"), sharedLight);
  assert.equal(sharedLight.version, "e3-light-20261005-v1");
  assert.equal(
    sharedLight.body,
    "窗边的小光点，刚才还在我的爪子旁边。\n我一眨眼，它就跑远了。\n明天它还会来吗？",
  );
  assert.ok(Object.isFrozen(sharedLight));
});

test("full payload digest catches non-body edits and is stable across jsonb key order", () => {
  const item =
    getCloudContent("L-FIREFLY") ??
    cloudContentItems.find((item) => item.type === "LINKED")!;
  const reordered = Object.fromEntries(Object.entries(item).reverse());
  assert.equal(cloudContentHash(item), cloudContentHash(reordered));
  assert.notEqual(
    cloudContentHash({ ...item, title: `${item.title}changed` }),
    cloudContentHash(item),
  );
  assert.notEqual(
    cloudContentHash({ ...item, claimRequirements: [] }),
    cloudContentHash(item),
  );
  assert.notEqual(
    cloudContentHash({ ...sharedLight, tip: "changed" }),
    cloudContentHash(sharedLight),
  );
  assert.equal(
    cloudBodyHash(item.body),
    createHash("sha256").update(item.body).digest("hex"),
  );
  assert.notEqual(
    cloudContentHash({ ...item, body: `${item.body}\n` }),
    cloudContentHash(item),
  );
});

test("content registration does not rewrite old frozen bytes", () => {
  const bytes = readFileSync(
    new URL("../../src/content/frozen.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "df48989c0e898b4c0df5df2c478524181d7ba76efa6cd22e627d430834a342f7",
  );
});
