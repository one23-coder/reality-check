/** Kernel-level tests for the evidence guarantees in this round
 * (方案 §3.3 规则 2 单一口径 / §4 铁律 3 内核核对证据引用 / §10 证据不完整降级).
 *
 * 三层验证链的第二层：a minimal FAKE adapter (7 methods, no browser, no app)
 * drives `executeScenario`, so the version/capability gates and the downgrade
 * ladder are exercised deterministically. The third layer — a real Chromium run
 * against a real app — lives in packages/cli and packages/adapter-local-web and
 * is NOT replaced by this file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  STEP_OPS,
  type AdapterManifest,
  type Attempt,
  type EnvSummary,
  type EvidenceRef,
  type Scenario,
} from "@rc/protocol";
import type { LocalWebAdapterV1, ObserverReading, StepContext } from "../src/adapter.js";
import { executeScenario } from "../src/engine.js";
import { isRunError } from "../src/errors.js";

const SQL = "SELECT COUNT(*) AS n FROM bookings";
const OBSERVERS: AdapterManifest["observers"] = {
  "booking-count": { sql: SQL, tables: ["bookings"], columns: ["n"] },
};

const tempRoots: string[] = [];

async function makeRunsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rc-engine-evidence-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    protocol: { scenario: "1.0" },
    id: "fake-scenario",
    name: "fake",
    description: "kernel-level fake adapter scenario",
    app: "fake-app",
    roles: [{ id: "alice", account: { username: "alice", password: "pw-alice" }, seedRole: "none" }],
    steps: [{ id: "s1", actor: "alice", op: "navigate", params: { path: "/" } }],
    observers: [{ id: "booking-count", sql: SQL, tables: ["bookings"], expectColumns: ["n"] }],
    assertions: [{ id: "a1", rule: "r1", observer: "booking-count", op: "eq", value: 2 }],
    rules: [{ id: "r1", description: "two bookings must exist" }],
    seed: 7,
    ...over,
  };
}

/** Write a real evidence file into the run's evidence dir and hash it. */
async function writeEvidence(runDir: string, name: string, body: string): Promise<EvidenceRef> {
  const dir = join(runDir, "evidence");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), body, "utf8");
  const ref: EvidenceRef = {
    kind: "sql-dump",
    file: `evidence/${name}`,
    seq: 0,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  return ref;
}

/** A ref pointing at a file that does not exist. */
function ghostRef(): EvidenceRef {
  return { kind: "sql-dump", file: "evidence/ghost.json", seq: 9, sha256: "0".repeat(64) };
}

/** A row-less reading with one verifiable evidence file. */
function rowsReading(rows: Record<string, unknown>[], evidence: EvidenceRef[]): ObserverReading {
  return { observerId: "booking-count", columns: ["n"], rows, evidence };
}

class FakeAdapter implements LocalWebAdapterV1 {
  runDir = "";
  dataRoot = "";
  teardowns = 0;
  /** username:seedRole for every role the kernel handed to setupEnv (规则 7). */
  seedRoles: string[] = [];
  /** "step-evidence": every step returns one verifiable ref + one ghost ref.
   * "db": setupEnv creates a db file under the data root (ownership ledger). */
  readonly behaviour: Set<string>;
  constructor(
    /** Build the observation AFTER the run dir exists (like a real adapter). */
    private readonly read: (runDir: string) => Promise<ObserverReading>,
    private readonly failSetup = false,
    private readonly observers: AdapterManifest["observers"] = OBSERVERS,
    behaviour: readonly string[] = [],
  ) {
    this.behaviour = new Set(behaviour);
  }

  manifest(): AdapterManifest {
    return {
      protocol: { manifest: "1.0" },
      adapterId: "fake-adapter",
      adapterVersion: "0.0.1",
      scenarioVersion: "1.0",
      supportedOps: [...STEP_OPS],
      supportedAssertions: ["eq", "ne", "gt", "gte", "lt", "lte", "countEq", "eqStr"],
      observedTables: ["bookings", "waitlist"],
      evidenceKinds: ["sql-dump"],
      barriers: true,
      observers: this.observers,
    };
  }
  async setupEnv(opts: {
    runDir: string;
    seed: number;
    dataRoot: string;
    roles: Scenario["roles"];
  }): Promise<EnvSummary> {
    if (this.failSetup) throw new Error("fake environment refused to start (方案 §10)");
    this.seedRoles = opts.roles.map((r) => `${r.account.username}:${r.seedRole}`);
    this.runDir = opts.runDir;
    this.dataRoot = opts.dataRoot;
    const summary: EnvSummary = {
      appVersion: "0.0.1",
      adapterVersion: "0.0.1",
      baseUrl: "http://127.0.0.1:0",
      seed: opts.seed,
      platform: "test",
    };
    if (this.behaviour.has("db")) {
      // A real app creates its DB under the data root we were handed.
      const dbPath = join(opts.dataRoot, "app.db");
      await mkdir(opts.dataRoot, { recursive: true });
      await writeFile(dbPath, "fake app db", "utf8");
      summary.dbPath = dbPath;
    }
    return summary;
  }
  async registerAccounts(): Promise<void> {}
  async runStep(step: Scenario["steps"][number], ctx: StepContext): Promise<Attempt> {
    const attempt: Attempt = {
      stepId: step.id,
      actor: step.actor,
      op: step.op,
      outcome: "completed",
    };
    if (this.behaviour.has("step-error")) {
      return {
        stepId: step.id,
        actor: step.actor,
        op: step.op,
        outcome: "error",
        detail: { error: "fake adapter: step could not be executed" },
      };
    }
    if (this.behaviour.has("step-rejected")) {
      return { stepId: step.id, actor: step.actor, op: step.op, outcome: "rejected" };
    }
    if (this.behaviour.has("step-evidence")) {
      // one ref whose bytes are really on disk + one ref that was never written
      attempt.evidence = [await writeEvidence(ctx.runDir, `step-${step.id}.json`, step.id), ghostRef()];
    }
    return attempt;
  }
  async runBarrier(steps: Scenario["steps"], ctx: StepContext): Promise<Attempt[]> {
    const out: Attempt[] = [];
    for (const s of steps) out.push(await this.runStep(s, ctx));
    return out;
  }
  async observe(_observerId: string): Promise<ObserverReading> {
    return this.read(this.runDir);
  }
  async captureEvidence(): Promise<EvidenceRef> {
    throw new Error("fake adapter: captureEvidence is not used by these tests");
  }
  async teardown(): Promise<string[]> {
    this.teardowns += 1;
    return [];
  }
}

describe("角色声明传递 (方案 §3.3 规则 7)", () => {
  it("hands every declared role (with its seedRole) to setupEnv, not just to registerAccounts", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []));
    await executeScenario(
      scenario({
        roles: [
          { id: "alice", account: { username: "alice", password: "pw-alice" }, seedRole: "none" },
          { id: "hold", account: { username: "hold_rc", password: "pw-hold" }, seedRole: "holder" },
          { id: "queued", account: { username: "queued_rc", password: "pw-q" }, seedRole: "waitlisted" },
        ],
      }),
      adapter,
      { runsRoot },
    );
    // A seeding adapter must see 占用意图 while the app starts — an account
    // created later cannot retroactively occupy an initial slot.
    assert.deepEqual(adapter.seedRoles, ["alice:none", "hold_rc:holder", "queued_rc:waitlisted"]);
  });
});

describe("单一口径 SQL 校验 (方案 §3.3 规则 2)", () => {
  it("accepts a scenario SQL differing from the manifest only in whitespace", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []));
    const result = await executeScenario(
      scenario({
        observers: [
          {
            id: "booking-count",
            sql: "SELECT   COUNT(*)\n    AS n   FROM bookings",
            tables: ["bookings"],
            expectColumns: ["n"],
          },
        ],
      }),
      adapter,
      { runsRoot },
    );
    assert.equal(result.verdict, "passed");
  });

  it("rejects a materially different SQL BEFORE any run directory is created (config error)", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []));
    await assert.rejects(
      () =>
        executeScenario(
          scenario({
            observers: [
              {
                id: "booking-count",
                sql: "SELECT COUNT(*) AS n FROM waitlist",
                tables: ["waitlist"],
                expectColumns: ["n"],
              },
            ],
          }),
          adapter,
          { runsRoot },
        ),
      (e: unknown) => {
        assert.ok(isRunError(e));
        assert.equal((e as { kind?: string }).kind, "config");
        return true;
      },
    );
    // Nothing started: no run dir, no environment, no teardown to run.
    assert.deepEqual(await readdir(runsRoot), []);
    assert.equal(adapter.teardowns, 0);
  });

  it("rejects an expectColumns entry the manifest does not declare", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []));
    await assert.rejects(
      () =>
        executeScenario(
          scenario({
            observers: [
              {
                id: "booking-count",
                sql: SQL,
                tables: ["bookings"],
                expectColumns: ["never-declared"],
              },
            ],
          }),
          adapter,
          { runsRoot },
        ),
      isRunError,
    );
  });
});

describe("证据引用核对 (方案 §4 铁律 3 + §10 降级)", () => {
  it("registers a verifiable evidence file and keeps the holding verdict", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async (runDir) =>
      rowsReading([{ n: 2 }], [await writeEvidence(runDir, "dump.json", "rows: 2")]),
    );
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "passed");
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]?.file, "evidence/dump.json");
    assert.equal(
      result.timeline.some((e) => e.kind === "evidence-invalid"),
      false,
    );
  });

  it("downgrades a holding assertion to inconclusive and names the evidence gap", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], [ghostRef()]));
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "inconclusive");
    const evaluation = result.ruleEvaluations[0];
    assert.equal(evaluation?.verdict, "inconclusive");
    assert.deepEqual(evaluation?.missingEvidenceTypes, ["evidence-file"]);
    // The invalid ref is dropped from the registered evidence, and the reason
    // lands in the timeline instead of disappearing.
    assert.deepEqual(result.evidence, []);
    const invalid = result.timeline.find((e) => e.kind === "evidence-invalid");
    assert.ok(invalid, "an evidence-invalid event must be recorded");
    assert.match(String(invalid.detail["reason"]), /does not exist/);
  });

  it("keeps the observation gap AND the evidence gap (no reason overwrites another)", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([], [ghostRef()]));
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "inconclusive");
    const gaps = result.ruleEvaluations[0]?.missingEvidenceTypes ?? [];
    assert.deepEqual([...gaps].sort(), ["evidence-file", "rows"]);
  });

  it("keeps a violated rule violated when its evidence is verifiable", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async (runDir) =>
      rowsReading([{ n: 5 }], [await writeEvidence(runDir, "dump.json", "rows: 5")]),
    );
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "failed");
    assert.equal(result.ruleEvaluations[0]?.verdict, "violated");
    assert.equal(result.ruleEvaluations[0]?.missingEvidenceTypes, undefined);
  });

  it("blocks (never throws) when the environment cannot start, and still tears down", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []), true);
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "blocked");
    assert.equal(result.ruleEvaluations[0]?.verdict, "not-evaluated");
    assert.equal(adapter.teardowns, 1, "teardown must run even for a blocked run");
  });
});

describe("步骤执行失败 ⇒ blocked，绝不产出业务结论 (方案 §10)", () => {
  it("blocks the run when a step could not be executed, naming the step", async () => {
    const runsRoot = await makeRunsRoot();
    // A step that errors means the business action never happened: the
    // untouched state could satisfy the assertions by accident, and reporting
    // "passed" there would be a claim about a run that did not take place.
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []), false, OBSERVERS, [
      "step-error",
    ]);
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "blocked");
    assert.equal(result.ruleEvaluations[0]?.verdict, "not-evaluated");
    assert.equal(result.attempts[0]?.outcome, "error");
    const blockedEvent = result.timeline.find((e) => e.kind === "blocked");
    assert.ok(blockedEvent, "a blocked event must name the failing stage");
    assert.equal(blockedEvent.detail["stage"], "steps");
    assert.deepEqual(blockedEvent.detail["steps"], ["s1"]);
  });

  it("keeps a rejected step as a business-observable outcome (not blocked)", async () => {
    const runsRoot = await makeRunsRoot();
    // "rejected" is the app's honest answer to a step that DID execute — that
    // is business information, so the run must still produce a verdict.
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []), false, OBSERVERS, [
      "step-rejected",
    ]);
    const result = await executeScenario(scenario(), adapter, { runsRoot });
    assert.equal(result.verdict, "passed");
    assert.equal(result.attempts[0]?.outcome, "rejected");
  });
});

describe("步骤证据的登记与核对 (方案 §10 证据)", () => {
  it("registers verifiable step evidence, drops the unverifiable ref and names it", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(
      async () => rowsReading([{ n: 2 }], []),
      false,
      OBSERVERS,
      ["step-evidence"],
    );
    const result = await executeScenario(scenario(), adapter, { runsRoot });

    // The real file is registered; the ghost ref never reaches the result.
    assert.deepEqual(
      result.evidence.map((e) => e.file),
      ["evidence/step-s1.json"],
    );
    const attempt = result.attempts[0];
    assert.equal(attempt?.evidence?.length, 1, "the attempt keeps only verifiable refs");
    assert.equal(attempt?.evidence?.[0]?.file, "evidence/step-s1.json");

    const invalid = result.timeline.find(
      (e) => e.kind === "evidence-invalid" && e.detail["stepId"] === "s1",
    );
    assert.ok(invalid, "the dropped step ref must be named in the timeline");
    assert.match(String(invalid.detail["reason"]), /does not exist/);

    // Step evidence is not an assertion subject: the verdict still comes from
    // the observer evidence only.
    assert.equal(result.verdict, "passed");
    const step = result.timeline.find((e) => e.kind === "step");
    assert.equal((step?.detail["evidence"] as number | undefined), 1);
  });
});

describe("数据根所有权台账 (方案 §10 数据隔离)", () => {
  it("claims the data root, registers the app's db and removes it from the ledger", async () => {
    const runsRoot = await makeRunsRoot();
    const adapter = new FakeAdapter(async () => rowsReading([{ n: 2 }], []), false, OBSERVERS, ["db"]);
    const result = await executeScenario(scenario(), adapter, { runsRoot });

    const dataRoot = join(runsRoot, result.runId, "data");
    // The ledger exists for THIS run and is the only owner of the root…
    const ledger = JSON.parse(await readFile(join(dataRoot, "ownership.json"), "utf8")) as {
      runId: string;
      dataRoot: string;
      entries: unknown[];
    };
    assert.equal(ledger.runId, result.runId);
    assert.equal(ledger.dataRoot, dataRoot);
    assert.deepEqual(ledger.entries, [], "every owned resource was torn down");

    // …and the app's db was actually removed by one of the two cleanup layers.
    assert.equal(existsSync(join(dataRoot, "app.db")), false);

    const tornDown = result.timeline.find((e) => e.kind === "torn-down");
    assert.ok(tornDown, "a torn-down event must be recorded");
    const ownership = tornDown.detail["ownership"] as { entries: number; removed: string[] };
    assert.equal(ownership.entries, 1);
    assert.deepEqual(
      ownership.removed.map((p) => p.replace(/\\/g, "/")),
      [`${dataRoot.replace(/\\/g, "/")}/app.db`],
    );
  });
});
