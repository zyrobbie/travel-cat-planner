/** Only explicit deployment configuration can enable the account handoff. */
export function safeBindingUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function accountBindingUrl(): string | null {
  return safeBindingUrl(import.meta.env.VITE_ACCOUNT_APP_URL)?.href ?? null;
}

export function allowedBindingSource(origin: string): boolean {
  const parsed = safeBindingUrl(origin);
  if (!parsed || parsed.origin !== origin || parsed.pathname !== "/")
    return false;
  const configured = import.meta.env.VITE_LEGACY_SOURCE_ORIGINS;
  if (!configured?.trim()) return origin === location.origin;
  return configured.split(",").some((entry) => {
    const candidate = safeBindingUrl(entry.trim());
    return candidate?.pathname === "/" && candidate.origin === origin;
  });
}
