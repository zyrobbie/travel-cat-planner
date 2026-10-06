export function versionTimeText(at: string | null | undefined) {
  if (!at) return "";
  const value = new Date(at);
  return Number.isNaN(value.valueOf()) ? "" : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(value);
}
