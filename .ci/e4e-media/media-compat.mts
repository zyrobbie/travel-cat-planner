/** Explicit ESM entrypoint; no dependency on a repository-root package scope. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [candidateArg, binArg, fixtureArg, reportArg] = process.argv.slice(2);
assert(candidateArg && binArg && fixtureArg && reportArg);
const candidate = await realpath(candidateArg);
const bin = await realpath(binArg);
const fixtures = await realpath(fixtureArg);
const source = await readFile(join(candidate, "src/server/voice-probe.ts"));
assert.equal(createHash("sha256").update(source).digest("hex"), "3f9832441a79a5327d9bfaee24dbdfdb02ef3ef66b11cf5788f4a82646c9e164");
const root = await realpath(await mkdtemp(join(tmpdir(), "cat-private-voice-media-")));
Object.assign(process.env, {
  APP_MODE: "INTERNAL", NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null",
  E4_VOICE_STORAGE: "synthetic-files-v1", E4_VALIDATION_LOCAL_NONCE: randomUUID(),
  E4_VOICE_TEST_PAYLOAD_ROOT: root, E4_VOICE_PAYLOAD_DIRECTORY: join(root, "payload"),
  E4_VOICE_PROBE_DIRECTORY: join(root, "probe"),
  E4_VOICE_FFMPEG: join(bin, "ffmpeg"), E4_VOICE_FFPROBE: join(bin, "ffprobe"),
});
const { inspectVoiceAudio, normalizeVoiceAudio } = await import(pathToFileURL(join(candidate, "src/server/voice-probe.ts")).href);
const manifest = JSON.parse(await readFile(join(fixtures, "manifest.json"), "utf8"));
assert.equal(manifest.syntheticOnly, true);
const cases: Array<Record<string, unknown>> = [];
async function record(name: string, work: () => Promise<Record<string, unknown> | void>) {
  const start = performance.now();
  try { cases.push({ name, status: "PASS", ...(await work() || {}), elapsedMs: Math.round(performance.now() - start) }); }
  catch (e) { cases.push({ name, status: "FAIL", error: String(e), elapsedMs: Math.round(performance.now() - start) }); }
}
async function cleanProbe() {
  const files = await readdir(join(root, "probe")).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return []; throw e;
  });
  assert.deepEqual(files, [], "probe/convert temporary directory survived completion");
}
function checkWav(wav: Buffer, seconds: number) {
  assert(wav.length > 44 && wav.length <= 1_920_044);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  const actualMs = (wav.length - 44) / 32;
  assert(actualMs > 0 && actualMs <= 60000);
  assert(Math.abs(actualMs - seconds * 1000) <= 80, `unexpected normalized duration ${actualMs}`);
  let sum = 0, peak = 0;
  for (let i = 44; i < wav.length; i += 2) { const value = wav.readInt16LE(i); sum += value * value; peak = Math.max(peak, Math.abs(value)); }
  const rms = Math.sqrt(sum / ((wav.length - 44) / 2));
  assert(rms > 100 && peak < 32767, "synthetic tone became silent or clipped");
  return { outputBytes: wav.length, actualMs, rms: Math.round(rms), peak };
}
async function expectRejected(data: Buffer, mime: string, signal?: AbortSignal) {
  await assert.rejects(() => normalizeVoiceAudio(data, mime, signal), (e: any) => e?.status === 400 || e?.status === 413);
  await cleanProbe();
}
try {
  for (const fixture of manifest.records) {
    await record(fixture.file, async () => {
      const data = await readFile(join(fixtures, fixture.file));
      assert.equal(createHash("sha256").update(data).digest("hex"), fixture.sha256);
      if (fixture.expected === "reject") { await expectRejected(data, fixture.mime); return { expected: "reject" }; }
      const inspectedMs = await inspectVoiceAudio(data, fixture.mime);
      assert(inspectedMs > 0 && inspectedMs <= 60000);
      const wav = await normalizeVoiceAudio(data, fixture.mime);
      const stats = checkWav(wav, fixture.sourceSeconds);
      await cleanProbe();
      return { expected: "accept", inspectedMs, ...stats };
    });
  }
  await record("empty-input", () => expectRejected(Buffer.alloc(0), "audio/wav"));
  await record("over-10MiB-input", () => expectRejected(Buffer.alloc(10 * 1024 * 1024 + 1), "audio/wav"));
  await record("wrong-mime", async () => expectRejected(await readFile(join(fixtures, "ogg-opus-1s.ogg")), "audio/wav"));
  await record("truncated-webm-header", async () => expectRejected((await readFile(join(fixtures, "webm-opus-1s.webm"))).subarray(0, 16), "audio/webm"));
  await record("magic-only-wav", () => expectRejected(Buffer.from("RIFFxxxxWAVEgarbage"), "audio/wav"));
  await record("cancel-before-probe", async () => {
    const controller = new AbortController(); controller.abort();
    await expectRejected(await readFile(join(fixtures, "webm-opus-60s.webm")), "audio/webm", controller.signal);
  });
  await record("two-concurrent-60s-normalizations", async () => {
    const [webm, ogg] = await Promise.all([readFile(join(fixtures, "webm-opus-60s.webm")), readFile(join(fixtures, "ogg-opus-60s.ogg"))]);
    const converted = await Promise.all([normalizeVoiceAudio(webm, "audio/webm"), normalizeVoiceAudio(ogg, "audio/ogg")]);
    converted.forEach(wav => checkWav(wav, 60));
    await cleanProbe();
  });
} finally {
  await rm(root, { recursive: true, force: true });
  const failures = cases.filter(test => test.status === "FAIL").length;
  await writeFile(resolve(reportArg), JSON.stringify({ schemaVersion: 1, candidateVersion: "v09-r2", candidateVoiceProbeSha256: createHash("sha256").update(source).digest("hex"),
    status: failures ? "FAIL" : "PASS_LIMITED", total: cases.length, failures,
    scope: "actual unchanged v09-r2 inspectVoiceAudio/normalizeVoiceAudio; synthetic fixtures; Linux CI only",
    notTested: ["human/browser recordings", "ASR", "real credentials", "cloud endpoints", "target server", "tmpfs storage", "in-progress cancellation", "timeout injection", "hostile media fuzzing", "nationwide network"], cases }, null, 2) + "\n");
  if (failures) process.exitCode = 1;
}
