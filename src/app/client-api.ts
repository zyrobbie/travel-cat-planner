export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error || "服务暂不可用。", r.status);
  return data;
}
export type Letter = {
  id: string;
  type: "DEMAND" | "POSTCARD";
  read_at: string | null;
  skipped_at: string | null;
  delivered_at: string;
  response: string | null;
  snapshot: {
    title: string;
    body: string;
    catName: string;
    tip: string | null;
    scene: string | null;
    season: string | null;
    timeOfDay: string | null;
  };
};
export type AppState = {
  participant: {
    id: string;
    cat_name: string | null;
    status: string;
    safety_state: string;
  };
  trip: { id: string } | null;
  letters: Letter[];
};
