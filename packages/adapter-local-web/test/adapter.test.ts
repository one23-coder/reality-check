// adapter-local-web tests (方案 §3.3 规则 10: unique ports per test via the
// adapter's own free-port probe; temp dirs under os.tmpdir()).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createLocalWebAdapter } from "../src/index.js";
import type { Role, Step } from "../src/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BOOKING_APP = path.join(REPO_ROOT, "fixtures", "booking-app", "server.js");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL, account TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id TEXT NOT NULL, account TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY, password TEXT NOT NULL, seed_role TEXT NOT NULL DEFAULT 'none'
);
`;

function role(id: string, username: string, password: string, seedRole: Role["seedRole"]): Role {
  return { id, account: { username, password }, seedRole };
}

/** Find a (key,value) cell in a single-column observer reading. */
function firstCell(reading: { rows: Record<string, unknown>[] }): unknown {
  const row = reading.rows[0];
  assert.ok(row, "observer returned no rows");
  return Object.values(row)[0];
}

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "rc-adapter-local-web-"));
}

test("manifest declares the adapter contract", () => {
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  const m = adapter.manifest();
  assert.equal(m.protocol.manifest, "1.0");
  assert.equal(m.adapterId, "adapter-local-web");
  assert.equal(m.adapterVersion, "0.1.0");
  assert.equal(m.scenarioVersion, "1.1");
  assert.equal(m.barriers, true);
  assert.deepEqual([...m.supportedOps].sort(), [
    "barrier",
    "click",
    "fill",
    "login",
    "navigate",
    "register",
    "submit",
    "wait",
  ]);
  for (const id of [
    "booking-count",
    "capacity-left",
    "waitlist-head",
    "waitlist-order",
    "seat-count",
    "seats-left",
  ]) {
    assert.ok(m.observers[id], `observer ${id} missing`);
  }
});

test("happy path: register/login/book through real pages, observers read committed state", async () => {
  const tmp = await makeTmp();
  const runDir = path.join(tmp, "run");
  const dataRoot = path.join(tmp, "data");
  // One holder via RC_SEED (occupies 1 of 2 slots, 规则 7), one fresh account.
  const roles = [role("alice", "alice", "pw-alice", "holder"), role("bob", "bob", "pw-bob", "none")];
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  try {
    const env = await adapter.setupEnv({ runDir, seed: 42, dataRoot, roles });
    assert.match(env.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(env.appVersion, "0.1.0");

    // Alice is already seeded by RC_SEED; registerAccounts must accept both.
    await adapter.registerAccounts(roles);

    const ctx = { runDir, seed: 42, event: async () => 0 };
    const steps: Step[] = [
      { id: "s1", actor: "bob", op: "navigate", params: { path: "/" } },
      { id: "s2", actor: "bob", op: "register", params: { username: "bob", password: "pw-bob" } },
      { id: "s3", actor: "bob", op: "login", params: { username: "bob", password: "pw-bob" } },
      { id: "s4", actor: "bob", op: "navigate", params: { path: "/book?course=course-1" } },
      { id: "s5", actor: "bob", op: "submit" },
    ];
    const attempts = [];
    for (const step of steps) {
      const attempt = await adapter.runStep(step, ctx);
      assert.equal(attempt.outcome, "completed", `${step.op} -> ${JSON.stringify(attempt)}`);
      attempts.push(attempt);
    }
    assert.equal(attempts[4]?.detail && (attempts[4].detail as Record<string, unknown>).banner, "报名成功");

    // Every step hands back verifiable evidence refs for the kernel to register
    // (方案 §4 铁律 3): screenshot + DOM snapshot, hashed, actor-tagged.
    assert.deepEqual(attempts[0]?.evidence?.map((e) => e.kind), ["screenshot", "dom-snapshot"]);
    assert.equal(attempts[0]?.evidence?.[0]?.actor, "bob");
    assert.match(String(attempts[0]?.evidence?.[0]?.sha256), /^[0-9a-f]{64}$/);
    assert.equal(attempts[4]?.evidence?.[1]?.file, "evidence/step-5-bob.dom.html");

    // Seeded holder booking + bob's booking.
    const count = await adapter.observe("booking-count");
    assert.equal(count.observerId, "booking-count");
    assert.deepEqual(count.columns, ["n"]);
    assert.equal(Number(firstCell(count)), 2);
    assert.equal(count.evidence.length, 1);
    assert.equal(count.evidence[0]?.kind, "sql-dump");

    const left = await adapter.observe("capacity-left");
    assert.equal(Number(firstCell(left)), 0);

    // Evidence actually landed on disk (方案 §10 证据: 采集即落盘).
    const evidenceDir = path.join(runDir, "evidence");
    const files = await readdir(evidenceDir);
    assert.ok(files.some((f) => f.startsWith("step-1-bob") && f.endsWith(".png")));
    assert.ok(files.some((f) => f.startsWith("step-5-bob") && f.endsWith(".dom.html")));
    assert.ok(files.some((f) => f.startsWith("obs-booking-count-") && f.endsWith(".json")));
  } finally {
    const removed = await adapter.teardown();
    assert.ok(removed.length >= 1, "teardown should report removed paths");
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rejected outcome: booking without login is honestly reported", async () => {
  const tmp = await makeTmp();
  const roles = [role("carol", "carol", "pw-carol", "none")];
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  try {
    await adapter.setupEnv({
      runDir: path.join(tmp, "run"),
      seed: 7,
      dataRoot: path.join(tmp, "data"),
      roles,
    });
    await adapter.registerAccounts(roles);
    const ctx = { runDir: path.join(tmp, "run"), seed: 7, event: async () => 0 };
    await adapter.runStep(
      { id: "r1", actor: "carol", op: "navigate", params: { path: "/book?course=course-1" } },
      ctx,
    );
    const attempt = await adapter.runStep({ id: "r2", actor: "carol", op: "submit" }, ctx);
    assert.equal(attempt.outcome, "rejected");
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("fault run (RC_FAULT=overbooking, capacity 0 free): two accounts book, violation is observable", async () => {
  const tmp = await makeTmp();
  const runDir = path.join(tmp, "run");
  const dataRoot = path.join(tmp, "data");
  // The "0 free slots" precondition is built through a SUPPORTED path — 规则 7:
  // two seedRole "holder" accounts occupy both slots at startup — instead of
  // pre-creating the DB file. Pre-seeding the file is refused by design
  // (方案 §10: a data root whose content this run does not own must not be used).
  const roles = [
    role("h1", "h1_rc", "pw-h1", "holder"),
    role("h2", "h2_rc", "pw-h2", "holder"),
    role("dan", "dan", "pw-dan", "none"),
    role("eve", "eve", "pw-eve", "none"),
  ];
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP, faultEnv: "overbooking" });
  try {
    await adapter.setupEnv({ runDir, seed: 1, dataRoot, roles });
    await adapter.registerAccounts(roles);
    // Capacity 2, both slots held by the seeded holders => 0 free.
    assert.equal(Number(firstCell(await adapter.observe("capacity-left"))), 0);
    const ctx = { runDir, seed: 1, event: async () => 0 };
    for (const actor of ["dan", "eve"]) {
      await adapter.runStep(
        { id: `f-${actor}-login`, actor, op: "login", params: { username: actor, password: `pw-${actor}` } },
        ctx,
      );
      await adapter.runStep(
        { id: `f-${actor}-nav`, actor, op: "navigate", params: { path: "/book?course=course-1" } },
        ctx,
      );
      const attempt = await adapter.runStep({ id: `f-${actor}-submit`, actor, op: "submit" }, ctx);
      assert.equal(attempt.outcome, "completed", `${actor} should book under the fault`);
    }
    // 0 free capacity, yet 2 more bookings exist — the violation the kernel catches.
    const count = await adapter.observe("booking-count");
    assert.equal(Number(firstCell(count)), 4);
    const left = await adapter.observe("capacity-left");
    assert.equal(Number(firstCell(left)), -2);
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("refuses to start against a data root whose db file this run does not own (方案 §10)", async () => {
  const tmp = await makeTmp();
  const dataRoot = path.join(tmp, "data");
  // Someone else's DB (a leftover run / a hand-made fixture) already sits at the
  // path we would use: reusing it would silently start from stale business data.
  mkdirSync(dataRoot, { recursive: true });
  const pre = new DatabaseSync(path.join(dataRoot, "app.db"));
  pre.exec(SCHEMA);
  pre.close();

  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  try {
    await assert.rejects(
      () => adapter.setupEnv({ runDir: path.join(tmp, "run"), seed: 3, dataRoot, roles: [] }),
      /already exists and is not owned by this run/,
    );
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a failed evidence capture is surfaced on the attempt, never silently dropped", async () => {
  const tmp = await makeTmp();
  const runDir = path.join(tmp, "run");
  const roles = [role("frank", "frank", "pw-frank", "none")];
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  try {
    await adapter.setupEnv({ runDir, seed: 5, dataRoot: path.join(tmp, "data"), roles });
    await adapter.registerAccounts(roles);
    // Make the evidence directory unwritable in a deterministic way: the path
    // becomes a plain FILE, so every capture into evidence/ must fail.
    const evidenceDir = path.join(runDir, "evidence");
    await rm(evidenceDir, { recursive: true, force: true });
    await writeFile(evidenceDir, "not a directory", "utf8");

    const ctx = { runDir, seed: 5, event: async () => 0 };
    const attempt = await adapter.runStep(
      { id: "e1", actor: "frank", op: "navigate", params: { path: "/" } },
      ctx,
    );
    // The step itself still happened honestly…
    assert.equal(attempt.outcome, "completed");
    // …and the evidence gap is named instead of being swallowed (方案 §4).
    const detail = (attempt.detail ?? {}) as Record<string, unknown>;
    assert.equal(typeof detail["evidenceError"], "string");
    assert.notEqual(detail["evidenceError"], "");
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
  }
});
