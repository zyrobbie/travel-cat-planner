import { createHash } from "node:crypto";
import content from "./frozen.json";
export function validateContent() {
  const expected = { DEMAND: 6, ORDINARY: 3, LINKED: 3, TIP: 6, SYSTEM: 53 };
  for (const [type, count] of Object.entries(expected))
    if (content.items.filter((x) => x.type === type).length !== count)
      throw Error(`Content count: ${type}`);
  if (new Set(content.items.map((x) => x.id)).size !== content.items.length)
    throw Error("Duplicate content");
  for (const x of content.items) {
    if (createHash("sha256").update(x.body).digest("hex") !== x.sha256)
      throw Error(`Body checksum: ${x.id}`);
    if (x.type === "SYSTEM" && /成长 \+1|你教会了它什么/.test(x.body))
      throw Error("Prohibited example imported");
    if (!x.body || x.body.includes("假设用户回应") || x.body.includes("turn0"))
      throw Error(`Invalid body: ${x.id}`);
    if (
      x.type === "LINKED" &&
      (!x.claimRequirements.length ||
        !content.items.some(
          (o) => o.id === x.ordinaryFallbackId && o.type === "ORDINARY",
        ))
    )
      throw Error(`Missing fallback: ${x.id}`);
  }
  return expected;
}
export { content };
