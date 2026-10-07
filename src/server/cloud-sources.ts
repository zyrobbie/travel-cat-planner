import { ensure } from "./errors";
import {
  cloudId,
  ownedCloudLetter,
  ownedCloudResponse,
  withCloudCat,
} from "./cloud-repository";

export async function readCloudSources(accountId: string, letterId: string) {
  cloudId.parse(letterId);
  return withCloudCat(accountId, async (db, cat) => {
    await ownedCloudLetter(db, cat, letterId);
    const r = await db.query(
      `SELECT s.response_id,s.revision,s.claim,s.start_offset,s.end_offset,
      r.letter_id,r.status,r.current_revision,v.text,v.at,l.snapshot->>'title' AS title
      FROM cloud_letter_sources s
      JOIN cloud_responses r ON (r.account_id,r.cat_id,r.id)=(s.account_id,s.cat_id,s.response_id)
      JOIN cloud_response_revisions v ON (v.account_id,v.cat_id,v.response_id,v.revision)=(s.account_id,s.cat_id,s.response_id,s.revision)
      JOIN cloud_letters l ON (l.account_id,l.cat_id,l.id)=(r.account_id,r.cat_id,r.letter_id)
      WHERE s.account_id=$1 AND s.cat_id=$2 AND s.letter_id=$3 ORDER BY s.source_order`,
      [accountId, cat.catId, letterId],
    );
    return {
      sources: r.rows.map((s) => {
        const base = {
          responseId: s.response_id,
          revision: s.revision,
          claim: s.claim,
          letterId: s.letter_id,
          title: s.title,
          at: s.at,
        };
        // No derived quote is stored: deleting all versions immediately removes every source excerpt.
        if (s.status === "DELETED")
          return { ...base, status: "DELETED", label: "已删除" };
        ensure(
          typeof s.text === "string" &&
            s.start_offset >= 0 &&
            s.end_offset <= s.text.length &&
            s.end_offset > s.start_offset,
          503,
          "来源暂不可用，请稍后再试。",
        );
        return {
          ...base,
          status: s.current_revision === s.revision ? "ACTIVE" : "CORRECTED",
          label: s.current_revision === s.revision ? "" : "已更正",
          // Source ranges were authored as JS UTF-16 offsets, not SQL Unicode code points.
          excerpt: s.text.slice(s.start_offset, s.end_offset),
        };
      }),
    };
  });
}

export async function readCloudResponse(accountId: string, responseId: string) {
  cloudId.parse(responseId);
  return withCloudCat(accountId, async (db, cat) => {
    const r = await ownedCloudResponse(db, cat, responseId);
    const base = {
      id: r.id,
      letterId: r.letter_id,
      currentRevision: r.current_revision,
      status: r.status,
    };
    if (r.status === "DELETED")
      return { response: { ...base, label: "已删除", revisions: [] } };
    const versions = await db.query(
      "SELECT revision,text,at FROM cloud_response_revisions WHERE cat_id=$1 AND account_id=$2 AND response_id=$3 ORDER BY revision",
      [cat.catId, accountId, responseId],
    );
    return {
      response: {
        ...base,
        revisions: versions.rows.map((v) => ({
          revision: v.revision,
          text: v.text,
          at: v.at,
        })),
      },
    };
  });
}
