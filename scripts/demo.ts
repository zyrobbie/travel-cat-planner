import { mkdir, writeFile, chmod } from "node:fs/promises";
import { newParticipant } from "../src/server/auth";
import { pool } from "../src/server/db";
try {
  const p = await newParticipant();
  await mkdir(".local", { recursive: true });
  await writeFile(
    ".local/demo-invite.json",
    JSON.stringify(
      {
        ...p,
        note: "Internal synthetic walkthrough only; no responses prefilled",
      },
      null,
      2,
    ),
  );
  await chmod(".local/demo-invite.json", 0o600);
  console.log(
    "Anonymous participant created. One-time invite saved in .local/demo-invite.json (not printed).",
  );
} finally {
  await pool.end();
}
