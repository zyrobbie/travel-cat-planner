export type SafetyState = "CLEAR" | "INTERCEPTED";
export function assertInternal() {
  if (
    process.env.APP_MODE !== "INTERNAL" ||
    process.env.SAFETY_ADAPTER !== "synthetic-v1"
  )
    throw new Error("Internal safety configuration required");
}
/** Exact, explicit synthetic markers only. This is NOT a crisis classifier. */
export function checkInput(text: string) {
  assertInternal();
  if (text === "[SYNTHETIC:UNAVAILABLE]")
    return { status: "UNAVAILABLE" as const, adapter: "synthetic-v1" };
  if (text === "[SYNTHETIC:INTERCEPT]")
    return { status: "INTERCEPTED" as const, adapter: "synthetic-v1" };
  return { status: "CLEAR" as const, adapter: "synthetic-v1" };
}
