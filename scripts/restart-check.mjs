import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const expected = JSON.parse(
  await readFile(".local/restart-expected.json", "utf8"),
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    storageState: ".local/restart-session.json",
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3100");
  await page.getByRole("button", { name: "来信盒", exact: true }).click();
  await page.getByRole("button", { name: /好多小星星飞起来啦/ }).click();
  await page.getByText(/怕把它们吓跑喵~/).waitFor({state:"visible"});
  const r = await context.request.get("http://127.0.0.1:3100/api/state");
  assert.equal(r.status(), 200);
  const state = await r.json();
  assert.equal(state.participant.id, expected.participantId);
  assert.equal(state.letters.length, expected.letterCount);
  assert.ok(state.letters.some((x) => x.response === expected.body));
  await page.screenshot({
    path: "/tmp/catletters-evidence/after-restart.png",
    fullPage: true,
  });
  console.log(
    "PASS: after app + PostgreSQL restart, same session/participant, 5 letters, original response and full postcard remain.",
  );
} finally {
  await browser.close();
}
