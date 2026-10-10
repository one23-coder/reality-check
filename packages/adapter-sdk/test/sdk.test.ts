// adapter-sdk tests (方案 §8: 一致性测试套件的正反例配对, §0).
//
// Positive: the reference adapter (createLocalWebAdapter serving the booking
// fixture) passes the FULL conformance suite. Negative: a deliberately broken
// adapter — same delegate, but captureEvidence returns a fake EvidenceRef
// pointing at a nonexistent file and the manifest claims barriers:false — must
// FAIL evidence-on-disk while the barrier-honesty check reflects the (honest)
// declaration. Also: report JSON round-trip, and the zero-dep static demo app
// usable with SDK helpers alone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalWebAdapter } from "@rc/adapter-local-web";
import type { Attempt, EvidenceKind, EvidenceRef, Role, Step } from "@rc/protocol";
import type { LocalWebAdapterV1, ObserverReading, StepContext } from "@rc/core";
import {
  freePort,
  freshSqliteRead,
  runConformanceSuite,
  sha256File,
  startStaticApp,
  waitForHealth,
  writeEvidenceFile,
  type ConformanceReport,
} from "../src/index.js";
;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BOOKING_APP = path.join(REPO_ROOT, "fixtures", "booking-app", "server.js");

async function makeWorkDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function checkByName(report: ConformanceReport, name: string): { pass: boolean; detail: string } {
  const found = report.checks.find((c) => c.name === name);
  assert.ok(found, `check "${name}" missing from report`);
  return found;
}

/** Deliberately broken adapter (反例): delegates everything to the real one but
 * (1) captureEvidence returns a ref to a file that was never written and
 * (2) the manifest claims barriers: false. Both are lies a conformance suite
 * must be able to catch — here, the barrier lie is HONEST capability
 * declaration (the suite must accept it), the evidence lie is not. */
class BrokenEvidenceAdapter implements LocalWebAdapterV1 {
  constructor(private readonly inner: LocalWebAdapterV1) {}

  manifest() {
    const m = this.inner.manifest();
    return { ...m, adapterId: "adapter-broken-evidence", barriers: false };
  }
  setupEnv(opts: Parameters<LocalWebAdapterV1["setupEnv"]>[0]): ReturnType<LocalWebAdapterV1["setupEnv"]> {
    return this.inner.setupEnv(opts);
  }
  registerAccounts(roles: Role[]): Promise<void> {
    return this.inner.registerAccounts(roles);
  }
  runStep(step: Step, ctx: StepContext): Promise<Attempt> {
    return this.inner.runStep(step, ctx);
  }
  runBarrier(steps: Step[], ctx: StepContext): Promise<Attempt[]> {
    return this.inner.runBarrier(steps, ctx);
  }
  observe(observerId: string): Promise<ObserverReading> {
    return this.inner.observe(observerId);
  }
  async captureEvidence(kind: EvidenceKind, actor?: string): Promise<EvidenceRef> {
    void actor;
    return { kind, file: "evidence/placeholder-nonexistent.bin", seq: 99999, sha256: "e".repeat(64) };
  }
  teardown(): Promise<string[]> {
    return this.inner.teardown();
  }
}

test("positive: reference adapter passes the full conformance suite", async () => {
  const workDir = await makeWorkDir("rc-sdk-positive-");
  try {
    const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
    const report = await runConformanceSuite(adapter, { appPath: BOOKING_APP, workDir });
    console.log("--- CONFORMANCE REPORT BEGIN ---");
    console.log(JSON.stringify(report, null, 2));
    console.log("--- CONFORMANCE REPORT END ---");
    assert.equal(report.adapterId, "adapter-local-web");
    assert.equal(report.checks.length, 6, `expected 6 checks, got: ${report.checks.map((c) => c.name).join(", ")}`);
    for (const c of report.checks) {
      assert.equal(c.pass, true, `check "${c.name}" failed: ${c.detail}`);
    }
    assert.equal(report.passed, true);

    // JSON round-trip is lossless (report is plain string/bool data).
    const roundTripped = JSON.parse(JSON.stringify(report)) as ConformanceReport;
    assert.deepEqual(roundTripped, report);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("negative: broken adapter fails evidence-on-disk; barrier declaration accepted", async () => {
  const workDir = await makeWorkDir("rc-sdk-broken-");
  try {
    const broken = new BrokenEvidenceAdapter(createLocalWebAdapter({ appPath: BOOKING_APP }));
    const report = await runConformanceSuite(broken, { appPath: BOOKING_APP, workDir });
    assert.equal(report.adapterId, "adapter-broken-evidence");
    assert.equal(report.passed, false, "broken adapter must not pass the suite");

    const evidence = checkByName(report, "evidence-on-disk");
    assert.equal(evidence.pass, false, `evidence-on-disk must fail, detail: ${evidence.detail}`);
    assert.match(evidence.detail, /placeholder-nonexistent\.bin|sha256/i);

    const barriers = checkByName(report, "barrier-declaration-honesty");
    assert.equal(barriers.pass, true, `barrier honesty must reflect the declaration, detail: ${barriers.detail}`);
    assert.match(barriers.detail, /declared false/);

    // Everything else must still pass — the ONLY lie is the evidence one.
    for (const c of report.checks) {
      if (c.name === "evidence-on-disk") continue;
      assert.equal(c.pass, true, `check "${c.name}" unexpectedly failed: ${c.detail}`);
    }

    // Broken report also JSON round-trips.
    const roundTripped = JSON.parse(JSON.stringify(report)) as ConformanceReport;
    assert.deepEqual(roundTripped, report);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("static demo app: SDK docs + helpers suffice without kernel source", async () => {
  const app = await startStaticApp();
  try {
    assert.equal(await freePort() > 0, true);
    await waitForHealth(app.baseUrl, 5_000);

    const res = await fetch(`${app.baseUrl}/notes`, {
      method: "POST",
      body: new URLSearchParams({ author: "external-dev", text: "hello sdk" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.status, 201);

    // Independent observation through a fresh connection (规则 1 by construction).
    const rows = await freshSqliteRead(app.dbPath, "SELECT text FROM notes ORDER BY id", ["notes"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.text, "hello sdk");

    // Whitelist rejection before any connection is opened.
    await assert.rejects(
      () => freshSqliteRead(app.dbPath, "SELECT * FROM secrets", ["notes"]),
      /outside the whitelist/,
    );
  } finally {
    await app.close();
  }
});

test("writeEvidenceFile hashes the exact bytes on disk", async () => {
  const dir = await makeWorkDir("rc-sdk-evidence-");
  try {
    const ref = await writeEvidenceFile(dir, "ev-1-page.txt", "exact bytes 123");
    assert.equal(ref.file, "evidence/ev-1-page.txt");
    assert.equal(ref.kind, "page-text");
    assert.equal(ref.sha256, await sha256File(path.join(dir, "evidence", "ev-1-page.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
