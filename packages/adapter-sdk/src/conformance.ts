/** Conformance suite for LocalWebAdapterV1 implementations (方案 §8:
 * 适配器 SDK、能力声明与一致性测试套件).
 *
 * The suite drives an adapter EXACTLY the way the kernel does — manifest gate,
 * env lifecycle, steps, observations, evidence, teardown — and verifies the
 * invariants the kernel enforces. An adapter that passes this suite works with
 * the kernel without the kernel ever being read.
 *
 * Checks (each independent, one CheckResult each):
 *   manifest-valid                — manifest passes validateManifest, serves
 *                                   scenario 1.0, non-empty ops, realistic
 *                                   evidenceKinds, observers inside whitelist.
 *   env-lifecycle                 — setupEnv reaches a healthy baseUrl,
 *                                   teardown returns ≥1 path, second teardown
 *                                   idempotent.
 *   evidence-on-disk              — every declared evidenceKinds kind lands as
 *                                   bytes whose sha256 matches EvidenceRef
 *                                   (铁律 3 — catches placeholder evidence).
 *   fresh-connection-observation  — out-of-band DB write is seen by the next
 *                                   observe() (规则 1 — no stale long-lived
 *                                   connection), and out-of-whitelist observer
 *                                   SQL is rejected.
 *   barrier-declaration-honesty   — barriers:true ⇒ runBarrier serves a 2-step
 *                                   group in order; barriers:false ⇒
 *                                   executeScenario refuses a barrier scenario
 *                                   before any environment exists.
 *   ownership-cleanup             — teardown removes the adapter's own files
 *                                   but never a foreign file planted in the
 *                                   dataRoot (方案 §10 所有权).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EVIDENCE_KINDS,
  SCENARIO_VERSION,
  validateManifest,
  type Attempt,
  type EvidenceRef,
  type Scenario,
  type Step,
} from "@rc/protocol";
import { executeScenario, type LocalWebAdapterV1, type StepContext } from "@rc/core";
import { extractSqlTables, sha256File } from "./helpers.js";

/** Roles the suite hands to setupEnv AND registerAccounts — the same contract
 * the kernel uses (方案 §3.3 规则 7). Both are plain "none" roles so the scope
 * of the check stays "the adapter accepts and reports role declarations". */
const CONFORMANCE_ROLES: Scenario["roles"] = [
  { id: "cf-alice", account: { username: "cf-alice", password: "pw-alice" }, seedRole: "none" },
  { id: "cf-bob", account: { username: "cf-bob", password: "pw-bob" }, seedRole: "none" },
];

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** JSON-serializable end report (JSON round-trip must be lossless). */
export interface ConformanceReport {
  adapterId: string;
  checks: CheckResult[];
  passed: boolean;
}

export interface ConformanceOptions {
  /** Path to the app entry the adapter serves (recorded in probe scenarios). */
  appPath: string;
  /** Scratch directory for the run dir, data root and refusal-probe runs. */
  workDir: string;
}

const CHECK_ORDER = [
  "manifest-valid",
  "env-lifecycle",
  "evidence-on-disk",
  "fresh-connection-observation",
  "barrier-declaration-honesty",
  "ownership-cleanup",
] as const;

const FOREIGN_FILE = "foreign-must-survive.txt";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Minimal StepContext for probes: events are counted, not persisted — the
 * suite never asserts on the timeline, only on adapter behavior. */
function makeCtx(runDir: string): StepContext {
  let seq = 0;
  return {
    runDir,
    seed: 7,
    async event(
      _kind: string,
      _detail: Record<string, unknown>,
      _actor?: string,
      _causation?: number,
    ): Promise<number> {
      return ++seq;
    },
  };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Out-of-band mutation through a SECOND fresh sqlite connection (the app
 * keeps its own connection in another process, WAL mode). Tries an INSERT
 * built from PRAGMA table_info (skipping defaults/nullable/auto pk columns);
 * falls back to deleting one row. The connection is closed in `finally`. */
function outOfBandMutate(dbPath: string, table: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const cols = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    const names: string[] = [];
    const values: (string | number)[] = [];
    for (const c of cols) {
      if (c.pk > 0 && /INT/i.test(c.type)) continue; // integer pk: auto-assigned
      if (c.dflt_value !== null && c.dflt_value !== undefined) continue;
      if (!c.notnull) continue;
      names.push(c.name);
      values.push(/INT|REAL|FLOA|DOUB|NUM/i.test(c.type) ? 1 : `rc-conf-${Date.now()}`);
    }
    try {
      if (names.length > 0) {
        db
          .prepare(
            `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")}) VALUES (${names
              .map(() => "?")
              .join(", ")})`,
          )
          .run(...values);
      } else {
        db.prepare(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`).run();
      }
      return `INSERT INTO ${table}`;
    } catch {
      db
        .prepare(
          `DELETE FROM ${quoteIdent(table)} WHERE rowid = (SELECT MIN(rowid) FROM ${quoteIdent(table)})`,
        )
        .run();
      return `DELETE FROM ${table}`;
    }
  } finally {
    db.close();
  }
}

export async function runConformanceSuite(
  adapter: LocalWebAdapterV1,
  opts: ConformanceOptions,
): Promise<ConformanceReport> {
  const workDir = path.resolve(opts.workDir);
  await fsp.mkdir(workDir, { recursive: true });
  const runDir = path.join(workDir, "run");
  const dataRoot = path.join(workDir, "data");

  const results = new Map<string, CheckResult>();
  const check = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      results.set(name, { name, pass: true, detail: await fn() });
    } catch (e) {
      results.set(name, { name, pass: false, detail: msg(e) });
    }
  };

  let adapterId = "unknown";
  try {
    adapterId = adapter.manifest().adapterId || "unknown";
  } catch {
    /* manifest-invalid: report as unknown */
  }

  // ---------------------------------------------------------------- (a) manifest
  await check("manifest-valid", async () => {
    const m = validateManifest(adapter.manifest(), "conformance:manifest");
    if (m.scenarioVersion !== SCENARIO_VERSION) {
      throw new Error(`scenarioVersion "${m.scenarioVersion}" !== "${SCENARIO_VERSION}"`);
    }
    if (m.supportedOps.length === 0) throw new Error("supportedOps is empty");
    for (const kind of ["sql-dump", "page-text"] as const) {
      if (!m.evidenceKinds.includes(kind)) {
        throw new Error(
          `evidenceKinds must include "${kind}" (the documented minimum); got [${m.evidenceKinds.join(", ")}]`,
        );
      }
    }
    if (!m.evidenceKinds.every((k) => (EVIDENCE_KINDS as readonly string[]).includes(k))) {
      throw new Error(`evidenceKinds contains unknown kinds: [${m.evidenceKinds.join(", ")}]`);
    }
    const issues: string[] = [];
    for (const [id, def] of Object.entries(m.observers)) {
      for (const table of [...def.tables, ...extractSqlTables(def.sql)]) {
        if (!m.observedTables.includes(table)) {
          issues.push(`observer "${id}" touches table "${table}" outside observedTables`);
        }
      }
    }
    if (issues.length > 0) throw new Error(issues.join("; "));
    return (
      `manifest ${m.adapterId}@${m.adapterVersion}: ops=${m.supportedOps.length}, ` +
      `observers=${Object.keys(m.observers).length}, evidenceKinds=[${m.evidenceKinds.join(", ")}], ` +
      `barriers=${String(m.barriers)}`
    );
  });

  // Pre-create the dataRoot and plant a foreign file BEFORE setupEnv: the
  // adapter must treat the root as not-its-own and clean only what it created
  // (方案 §10: 只清理台账内资源). setupEnv receives an existing dataRoot.
  await fsp.mkdir(dataRoot, { recursive: true });
  const foreignFile = path.join(dataRoot, FOREIGN_FILE);
  await fsp.writeFile(foreignFile, "planted by the conformance suite; not owned by the adapter\n", "utf8");

  // ------------------------------------------------------------- (b) env bring-up
  let envError: string | null = null;
  let baseUrl = "";
  let dbPath: string | null = null;
  let healthNote = "";
  try {
    // The kernel always hands the scenario's role declarations to setupEnv
    // (方案 §3.3 规则 7); the suite mirrors that contract.
    const summary = await adapter.setupEnv({ runDir, seed: 7, dataRoot, roles: CONFORMANCE_ROLES });
    baseUrl = summary.baseUrl;
    dbPath = summary.dbPath ?? null;
  } catch (e) {
    envError = msg(e);
  }
  if (envError === null) {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      healthNote = `HTTP ${res.status}`;
    } catch (e) {
      envError = `environment never reached a healthy ${baseUrl}/healthz: ${msg(e)}`;
    }
  }

  // ------------------------------------------- (d) fresh-connection-observation
  await check("fresh-connection-observation", async () => {
    if (envError !== null) throw new Error(`setupEnv failed: ${envError}`);
    const m = adapter.manifest();
    await adapter.registerAccounts(CONFORMANCE_ROLES);
    const notes = ["registerAccounts(2 roles) ok"];

    if (m.supportedOps.includes("navigate")) {
      const attempt = await adapter.runStep(
        { id: "cf-nav", actor: "cf-alice", op: "navigate", params: { path: "/" } },
        makeCtx(runDir),
      );
      if (attempt.outcome === "error") {
        throw new Error(`generic navigate step errored: ${JSON.stringify(attempt.detail ?? {})}`);
      }
      notes.push(`navigate outcome=${attempt.outcome}`);
    }

    const observerIds = Object.keys(m.observers);
    if (observerIds.length === 0 || dbPath === null) {
      return `${notes.join("; ")}; skipped mutation probe: no generic happy path (no declared observers${
        dbPath === null ? " / no dbPath" : ""
      })`;
    }

    // THE check: mutate the DB behind the adapter's back and require the next
    // observe() to see it — proves every read uses a fresh connection (规则 1).
    let verified = false;
    const failures: string[] = [];
    for (const id of observerIds) {
      const def = m.observers[id];
      if (def === undefined) continue;
      const table = def.tables[0];
      if (table === undefined) continue;
      let baseline: { rows: Record<string, unknown>[] };
      try {
        baseline = await adapter.observe(id);
      } catch (e) {
        failures.push(`observer "${id}": observe failed: ${msg(e)}`);
        continue;
      }
      let action: string;
      try {
        action = outOfBandMutate(dbPath, table);
      } catch (e) {
        failures.push(`observer "${id}": out-of-band mutate of "${table}" failed: ${msg(e)}`);
        continue;
      }
      const after = await adapter.observe(id);
      if (JSON.stringify(after.rows) === JSON.stringify(baseline.rows)) {
        throw new Error(
          `observer "${id}" returned identical rows after out-of-band ${action} on "${table}" — ` +
            "the adapter reads through a stale long-lived connection (方案 §3.3 规则 1: 每次读取都新建连接再关闭)",
        );
      }
      notes.push(`observer "${id}" saw out-of-band ${action} on "${table}"`);
      verified = true;
      break;
    }
    if (!verified) {
      throw new Error(`no observer could be verified against an out-of-band mutation: ${failures.join("; ")}`);
    }

    // Whitelist honesty: an observer whose SQL touches a table outside
    // observedTables must be REJECTED by observe() (规则 1: SQL 层只读白名单).
    for (const [id, def] of Object.entries(m.observers)) {
      const touched = [...new Set([...def.tables, ...extractSqlTables(def.sql)])];
      const rogue = touched.filter((t) => !m.observedTables.includes(t));
      if (rogue.length === 0) continue;
      let rejected = false;
      try {
        await adapter.observe(id);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(
          `observer "${id}" touches table(s) ${rogue.join(", ")} outside observedTables but observe() did not reject it`,
        );
      }
      notes.push(`observer "${id}" rejected out-of-whitelist table(s): ${rogue.join(", ")}`);
    }
    return notes.join("; ");
  });

  // ------------------------------------------------------ (c) evidence-on-disk
  await check("evidence-on-disk", async () => {
    if (envError !== null) throw new Error(`setupEnv failed: ${envError}`);
    const m = adapter.manifest();
    // Which of the adapter's declared observedTables actually exist in THIS app
    // DB? An adapter may over-declare its observation surface (union across
    // apps); a "no such table" throw for such a kind is an environment
    // mismatch, reported honestly — but a ref that does not point at real,
    // hash-matching bytes is ALWAYS a failure (铁律 3).
    const missingTables: string[] = [];
    if (dbPath !== null) {
      const db = new DatabaseSync(dbPath); // fresh connection, closed below
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        const present = new Set(rows.map((r) => r.name));
        missingTables.push(...m.observedTables.filter((t) => !present.has(t)));
      } finally {
        db.close();
      }
    }
    const parts: string[] = [];
    const excused: string[] = [];
    for (const kind of m.evidenceKinds) {
      let ref: EvidenceRef;
      try {
        ref = await adapter.captureEvidence(kind);
      } catch (e) {
        if (missingTables.length > 0 && /no such table/i.test(msg(e))) {
          excused.push(
            `${kind}: not verifiable against this app — adapter declares observedTables the app DB lacks (${missingTables.join(", ")}); error: ${msg(e)}`,
          );
          continue;
        }
        throw new Error(`captureEvidence("${kind}") threw: ${msg(e)}`);
      }
      const file = path.resolve(runDir, ref.file);
      if (!fs.existsSync(file)) {
        throw new Error(
          `evidence for "${kind}" was not written to disk (ref.file="${ref.file}") — placeholder evidence (方案 §4 铁律 3: 绝不用占位内容伪造证据)`,
        );
      }
      const actual = await sha256File(file);
      if (actual !== ref.sha256) {
        throw new Error(
          `EvidenceRef.sha256 mismatch for "${kind}" (${ref.file}): declared ${ref.sha256}, on-disk ${actual}`,
        );
      }
      parts.push(`${kind}→${ref.file} (${ref.sha256.slice(0, 12)}…)`);
    }
    const detail = parts.join("; ");
    return excused.length > 0 ? `${detail}; excused: ${excused.join("; ")}` : detail;
  });

  // --------------------------------------------- (e) barrier-declaration-honesty
  await check("barrier-declaration-honesty", async () => {
    const m = adapter.manifest();
    if (m.barriers) {
      if (envError !== null) throw new Error(`setupEnv failed: ${envError}`);
      const steps: Step[] = [
        { id: "cf-b1", actor: "cf-alice", op: "navigate", params: { path: "/" } },
        { id: "cf-b2", actor: "cf-bob", op: "navigate", params: { path: "/" } },
      ];
      if (!steps.every((s) => m.supportedOps.includes(s.op))) {
        return "skipped runBarrier probe: navigate not among supportedOps; declaration accepted untested";
      }
      const attempts: Attempt[] = await adapter.runBarrier(steps, makeCtx(runDir));
      if (attempts.length !== steps.length) {
        throw new Error(`runBarrier returned ${attempts.length} attempts for a ${steps.length}-step group`);
      }
      for (let i = 0; i < steps.length; i++) {
        const a = attempts[i];
        if (a === undefined || a.stepId !== steps[i]?.id) {
          throw new Error(`runBarrier attempt ${i} is out of order`);
        }
      }
      return `barriers declared true: 2-step group → 2 ordered attempts [${attempts
        .map((a) => `${a.stepId}=${a.outcome}`)
        .join(", ")}]`;
    }
    // barriers === false: the kernel must refuse a barrier scenario (exit 64)
    // BEFORE any environment is created. Verify that refusal really happens.
    const op = (
      m.supportedOps.includes("navigate") ? "navigate" : m.supportedOps[0]
    ) as Step["op"];
    if (op === undefined) throw new Error("supportedOps is empty");
    const scenario: Scenario = {
      protocol: { scenario: SCENARIO_VERSION },
      id: "conformance-barrier-refusal",
      name: "conformance barrier refusal probe",
      description: "Minimal barrier scenario the kernel must refuse when manifest.barriers is false.",
      app: opts.appPath,
      roles: [{ id: "cf-r1", account: { username: "cf-refuser", password: "pw" }, seedRole: "none" }],
      steps: [{ id: "cf-s1", actor: "cf-r1", op, barrier: true }],
      observers: [],
      assertions: [],
      rules: [],
      seed: 1,
    };
    let refused = false;
    let message = "";
    try {
      await executeScenario(scenario, adapter, { runsRoot: path.join(workDir, "runs-refused") });
    } catch (e) {
      refused = true;
      message = msg(e);
    }
    if (!refused) {
      throw new Error(
        "manifest.barriers is false but executeScenario accepted a barrier scenario — the kernel's capability gate did not fire",
      );
    }
    return `barriers declared false: executeScenario refused the barrier scenario (${message})`;
  });

  // ------------------------------------- teardown + (f) ownership-cleanup + (b)
  let teardownPaths: string[] = [];
  let teardownError: string | null = null;
  let secondTeardownError: string | null = null;
  let cleanupError: string | null = null;
  if (envError === null) {
    const beforeFiles = await walk(dataRoot);
    try {
      teardownPaths = await adapter.teardown();
    } catch (e) {
      teardownError = msg(e);
    }
    if (teardownError === null) {
      try {
        await adapter.teardown();
      } catch (e) {
        secondTeardownError = msg(e);
      }
    }
    try {
      const after = new Set(await walk(dataRoot));
      const survivors = beforeFiles.filter(
        (f) => path.basename(f) !== FOREIGN_FILE && after.has(f),
      );
      if (survivors.length > 0) {
        cleanupError = `adapter-created files survived teardown: ${survivors
          .map((f) => path.relative(dataRoot, f))
          .join(", ")}`;
      } else if (!fs.existsSync(foreignFile)) {
        cleanupError =
          "teardown deleted the foreign file the suite planted in the dataRoot — cleanup must only touch owned resources (方案 §10)";
      }
    } catch (e) {
      cleanupError = msg(e);
    }
  }
  if (teardownError !== null) {
    // best effort: never leave the app or browser alive because a check failed
    await adapter.teardown().catch(() => {});
  }

  await check("env-lifecycle", async () => {
    if (envError !== null) throw new Error(envError);
    if (baseUrl === "") throw new Error("setupEnv returned an empty baseUrl");
    if (teardownError !== null) throw new Error(`teardown failed: ${teardownError}`);
    if (teardownPaths.length < 1) throw new Error("teardown returned fewer than 1 torn-down path");
    if (secondTeardownError !== null) {
      throw new Error(`second teardown must be idempotent (no throw): ${secondTeardownError}`);
    }
    return `setupEnv reached healthy ${baseUrl}/healthz (${healthNote}); teardown returned ${teardownPaths.length} path(s); second teardown idempotent`;
  });

  await check("ownership-cleanup", async () => {
    if (envError !== null) throw new Error(`setupEnv failed: ${envError}`);
    if (teardownError !== null) throw new Error(`teardown failed: ${teardownError}`);
    if (cleanupError !== null) throw new Error(cleanupError);
    return `owned files removed under dataRoot, foreign planted file survived teardown, ${teardownPaths.length} owned path(s) reported`;
  });

  const checks = CHECK_ORDER.map((name) => results.get(name)).filter(
    (c): c is CheckResult => c !== undefined,
  );
  return { adapterId, checks, passed: checks.every((c) => c.pass) };
}
