// adapter-local-web tests (方案 §3.3 规则 10: unique ports per test via the
// adapter's own free-port probe; temp dirs under os.tmpdir()).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  BOOKING_OBSERVERS,
  EXAM_OBSERVERS,
  OBSERVERS_FILENAME,
  createLocalWebAdapter,
  type LocalWebAdapter,
} from "../src/index.js";
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
    "booking-holder",
  ]) {
    assert.ok(m.observers[id], `observer ${id} missing`);
  }
  // 口径属于**应用**：booking 应用的清单里不该出现 exam 的观察器，否则一份 booking
  // 场景可能悄悄用上另一张表的语义。
  for (const id of ["seat-count", "seats-left", "reservation-holder"]) {
    assert.equal(m.observers[id], undefined, `${id} must not be declared by the booking app`);
  }
});

/** 观察器属于**应用**，不属于适配器：接入新应用不能要求改适配器源码。 */
const CUSTOM_OBSERVERS = {
  observedTables: ["courses", "bookings"],
  observers: {
    "my-left": {
      sql: "SELECT capacity - (SELECT COUNT(*) FROM bookings WHERE bookings.course_id = courses.id) AS left FROM courses WHERE id = 'course-1'",
      tables: ["courses", "bookings"],
      columns: ["left"],
    },
  },
};

test("observers are discovered next to the app entry — no adapter source change", async () => {
  const tmp = await makeTmp();
  const appDir = path.join(tmp, "app");
  mkdirSync(appDir, { recursive: true });
  await writeFile(
    path.join(appDir, "reality-check.observers.json"),
    JSON.stringify(CUSTOM_OBSERVERS),
    "utf8",
  );
  // manifest() is static metadata: the app file itself need not exist here.
  const adapter = createLocalWebAdapter({ appPath: path.join(appDir, "server.js") });
  const m = adapter.manifest();
  // 内置预设（booking/exam）不再出现 —— 观察器口径来自这个应用自己的声明。
  assert.deepEqual(Object.keys(m.observers), ["my-left"]);
  assert.deepEqual([...m.observedTables].sort(), ["bookings", "courses"]);
  assert.equal(m.observers["my-left"]?.columns[0], "left");
  await rm(tmp, { recursive: true, force: true });
});

test("an app-owned observer works end to end (real app, custom SQL)", async () => {
  const tmp = await makeTmp();
  const runDir = path.join(tmp, "run");
  const observersFile = path.join(tmp, "observers.json");
  await writeFile(observersFile, JSON.stringify(CUSTOM_OBSERVERS), "utf8");
  const roles = [role("h1", "h1_rc", "pw-h1", "holder")];
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP, observersFile });
  try {
    await adapter.setupEnv({ runDir, seed: 7, dataRoot: path.join(tmp, "data"), roles });
    await adapter.registerAccounts(roles);
    // capacity 2，种子 holder 占 1 → 自定义口径读到 1
    assert.equal(Number(firstCell(await adapter.observe("my-left"))), 1);
    // 内置观察器已不在清单里：不会悄悄回退到 preset
    await assert.rejects(() => adapter.observe("capacity-left"), /unknown observer "capacity-left"/);
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rejects malformed observer configs with a named reason (config error, not silent fallback)", async () => {
  const tmp = await makeTmp();
  const write = async (name: string, body: string): Promise<string> => {
    const file = path.join(tmp, name);
    await writeFile(file, body, "utf8");
    return file;
  };
  assert.throws(
    () => createLocalWebAdapter({ appPath: BOOKING_APP, observersFile: path.join(tmp, "nope.json") }),
    /observers file not found/,
  );
  const badJson = await write("bad.json", "{oops");
  assert.throws(
    () => createLocalWebAdapter({ appPath: BOOKING_APP, observersFile: badJson }),
    /invalid JSON/,
  );
  assert.throws(
    () =>
      createLocalWebAdapter({
        appPath: BOOKING_APP,
        observers: {
          ghost: { sql: "SELECT 1", tables: ["not_declared"], columns: ["x"] },
        },
        observedTables: ["bookings"],
      }),
    /declares table "not_declared" which is not in observedTables/,
  );
  assert.throws(
    () =>
      createLocalWebAdapter({
        appPath: BOOKING_APP,
        observers: { half: { sql: "SELECT 1", tables: ["bookings"] } as never },
      }),
    /needs "columns"/,
  );
  await rm(tmp, { recursive: true, force: true });
});

test("a fixture-process spawn failure is attributable instead of an uncaught throw", async () => {
  const tmp = await makeTmp();
  const adapter = createLocalWebAdapter({ appPath: BOOKING_APP });
  try {
    // 同一段代码路径就是 `child.on("error")` 的监听器：以前这里 throw，会变成
    // 未捕获异常 —— 进程直接死，没有 blocked 事件，也没有 result.json。
    adapter.noteChildError(new Error("spawn ENOENT"));
    await assert.rejects(() => adapter.observe("booking-count"), /fixture app process failed: spawn ENOENT/);
    const attempt = await adapter.runStep(
      { id: "x", actor: "bob", op: "navigate", params: { path: "/" } },
      { runDir: path.join(tmp, "run"), seed: 1, event: async () => 0 },
    );
    assert.equal(attempt.outcome, "error");
    assert.match(String((attempt.detail as Record<string, unknown>)["error"]), /fixture app process failed/);
  } finally {
    await adapter.teardown();
    await rm(tmp, { recursive: true, force: true });
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

test("observer sql must be a single read-only statement (规则 1 covers the statement, not just table names)", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "obs.json");
  const build = async (sql: string): Promise<LocalWebAdapter> => {
    await writeFile(
      file,
      JSON.stringify({
        observedTables: ["bookings"],
        observers: { o: { sql, tables: ["bookings"], columns: ["n"] } },
      }),
      "utf8",
    );
    return createLocalWebAdapter({ appPath: BOOKING_APP, observersFile: file });
  };
  // 实测（node:sqlite）：prepare("INSERT INTO t VALUES(1)").all() 返回 []，
  // 但行真的写进了库。一条写语句会静默改写被测应用的状态 = 伪造结论。
  await assert.rejects(() => build("INSERT INTO bookings (course_id) VALUES ('course-1')"), /must start with SELECT or WITH/);
  await assert.rejects(() => build("UPDATE bookings SET account = 'x'"), /must start with SELECT or WITH/);
  await assert.rejects(() => build("DELETE FROM bookings"), /must start with SELECT or WITH/);
  await assert.rejects(() => build("PRAGMA journal_mode = WAL"), /must start with SELECT or WITH/);
  await assert.rejects(() => build("-- a comment\n/* b */ DELETE FROM bookings"), /must start with SELECT or WITH/);
  await assert.rejects(() => build("SELECT 1 AS n FROM bookings; DELETE FROM bookings"), /single statement/);
  const ok = await build("SELECT COUNT(*) AS n FROM bookings");
  assert.deepEqual(Object.keys(ok.manifest().observers), ["o"]);
  await rm(tmp, { recursive: true, force: true });
});

test("declared tables must be plain identifiers (they are interpolated into dump SQL)", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "obs.json");
  await writeFile(
    file,
    JSON.stringify({
      observedTables: ["bookings; DROP TABLE bookings"],
      observers: { o: { sql: "SELECT 1 AS n FROM bookings", tables: ["bookings"], columns: ["n"] } },
    }),
    "utf8",
  );
  assert.throws(
    () => createLocalWebAdapter({ appPath: BOOKING_APP, observersFile: file }),
    /not a plain SQL identifier/,
  );
  await rm(tmp, { recursive: true, force: true });
});

test("an app that declares no observers is a named config error, never a silent preset fallback", async () => {
  const tmp = await makeTmp();
  const appDir = path.join(tmp, "app-with-no-observers");
  mkdirSync(appDir, { recursive: true });
  const entry = path.join(appDir, "server.js");
  await writeFile(entry, "// an app that never declared its 口径\n", "utf8");
  // 第三方应用只要有一张同名表（含义不同），静默回退就会用 fixture 的口径
  // （course-1 / holder_rc）给出一个看起来完全正常的错误结论。
  assert.throws(() => createLocalWebAdapter({ appPath: entry }), /no observers declared for app/);
  // 显式 opt-in 仍可用：只读静态元数据的场合（MCP 能力门禁）不发生任何观察。
  assert.ok(
    Object.keys(createLocalWebAdapter({ appPath: entry, allowBundledPreset: true }).manifest().observers)
      .length > 0,
  );
  // 入口**不存在**是另一类缺失：运行会以 blocked 结束（setupEnv 起不来），
  // 观察器根本用不上，不能提前把它变成 exit 64 配置错误。
  const missing = path.join(appDir, "not-written-yet.js");
  assert.ok(Object.keys(createLocalWebAdapter({ appPath: missing }).manifest().observers).length > 0);
  await rm(tmp, { recursive: true, force: true });
});

test("the bundled fixture apps ship their own observer declarations, matching the presets", async () => {
  const cases = [
    { app: "booking-app", preset: BOOKING_OBSERVERS },
    { app: "exam-seat-app", preset: EXAM_OBSERVERS },
  ] as const;
  for (const c of cases) {
    const dir = path.join(REPO_ROOT, "fixtures", c.app);
    const doc = JSON.parse(
      await readFile(path.join(dir, OBSERVERS_FILENAME), "utf8"),
    ) as { observedTables: string[]; observers: Record<string, { tables: string[] }> };
    // 预设常量与随应用分发的配置文件必须一致，否则测试与真实运行会走不同口径。
    assert.deepEqual(doc.observers, c.preset, `${c.app}/${OBSERVERS_FILENAME} drifted from its preset`);
    for (const o of Object.values(doc.observers))
      for (const t of o.tables) assert.ok(doc.observedTables.includes(t));
    const m = createLocalWebAdapter({ appPath: path.join(dir, "server.js") }).manifest();
    assert.deepEqual(Object.keys(m.observers).sort(), Object.keys(c.preset).sort());
  }
});
