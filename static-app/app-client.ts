import { api, selectedId } from "./local-api";
import {
  listParticipants,
  subscribe,
  saveDraft,
  editResponse,
  deleteResponse,
} from "./store";
import type { LocalState, Claim } from "./model";

// The view consumes only this projection. Cloud clients never manufacture a local calendar.
export type ViewState = Pick<
  LocalState,
  "participant" | "trip" | "letters" | "drafts" | "responses"
> & {
  calendar?: LocalState["calendar"];
  storageNotice?: string;
};
export type SourceView = {
  responseId: string;
  revision: number;
  claim: Claim;
  letterId: string;
  title: string;
  at: string | null;
  status: "ACTIVE" | "CORRECTED" | "DELETED";
  label: string;
  excerpt?: string;
};
export interface AppClient {
  mode: "local" | "account";
  api: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  selectedId: () => string;
  listParticipants: typeof listParticipants;
  subscribe: typeof subscribe;
  saveDraft: typeof saveDraft;
  editResponse: typeof editResponse;
  deleteResponse: (
    id: string,
    responseId: string,
    expectedRevision: number,
  ) => Promise<{ message?: string; safety?: string }>;
  detail?: (letterId: string) => Promise<ViewState>;
  sources?: (letterId: string) => Promise<SourceView[]>;
  exportSelected?: () => Promise<void>;
}
export const localClient: AppClient = {
  mode: "local",
  api,
  selectedId,
  listParticipants,
  subscribe,
  saveDraft,
  editResponse,
  deleteResponse,
  exportSelected: async () => {
    const { exportSelectedCat } = await import("./legacy-export");
    await exportSelectedCat();
  },
};
