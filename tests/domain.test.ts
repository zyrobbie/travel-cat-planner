import test from "node:test";
import assert from "node:assert/strict";
import { validateContent, content } from "../src/content/validate";
import { checkInput } from "../src/server/safety";
test("Frozen content exact hashes/counts, no negative system examples, paired scene metadata", () => {
  assert.equal(validateContent().SYSTEM, 53);
  for (const c of content.items.filter((c) => c.type === "LINKED")) {
    const o = content.items.find((o) => o.id === c.ordinaryFallbackId)!;
    assert.equal(c.narrativeSeason, o.narrativeSeason);
    assert.equal(
      "timeOfDay" in c ? c.timeOfDay : null,
      "timeOfDay" in o ? o.timeOfDay : null,
    );
  }
});
test("Synthetic adapter uses explicit fixtures only and has an unavailable branch", () => {
  process.env.APP_MODE = "INTERNAL";
  process.env.SAFETY_ADAPTER = "synthetic-v1";
  assert.equal(checkInput("[SYNTHETIC:INTERCEPT]").status, "INTERCEPTED");
  assert.equal(checkInput("[SYNTHETIC:UNAVAILABLE]").status, "UNAVAILABLE");
  assert.equal(checkInput("普通合成输入").status, "CLEAR");
});
