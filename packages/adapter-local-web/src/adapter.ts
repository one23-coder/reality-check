/** Playwright-driven local web adapter (方案 §3.3 / §10).
 *
 * Spawns a zero-dep fixture app on a free port with RC_* env, drives it with
 * one Playwright browser context per role, observes app state through fresh
 * node:sqlite connections (规则 1), and lands every piece of evidence on disk
 * immediately (§10 证据).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
  AdapterManifest,
  Attempt,
  EnvSummary,
  EvidenceKind,
  EvidenceRef,
  ObserverReading,
  Role,
  Step,
  StepContext,
} from "./types.js";

/** One observer: the SQL that defines a business fact, plus what it touches.
 * 断言主体必须复用这些口径（规则 2「单一口径」），所以它们由**适配器/应用配置**
 * 声明，而不是由场景随手写。 */
export interface ObserverSpec {
  sql: string;
  tables: string[];
  columns: string[];
}

/** Per-app observer config, looked up next to the app entry (dirname(appPath)).
 * Shape: `{ "observedTables": [...], "observers": { <id>: {sql, tables, columns} } }`
 * (a bare `{ <id>: {...} }` record is also accepted). */
export const OBSERVERS_FILENAME = "reality-check.observers.json";

export interface LocalWebAdapterOptions {
  /** Absolute or cwd-relative path to the fixture app entry (node script). */
  appPath: string;
  /** Value for the app's RC_FAULT env; omit/empty to run a correct app. */
  faultEnv?: string;
  /** Observers for THIS app. Required to adopt a new app — see `observersFile`
   * and `${OBSERVERS_FILENAME}` for the no-source-change route. */
  observers?: Record<string, ObserverSpec>;
  /** Read the observers from this file instead of the app directory. */
  observersFile?: string;
  /** SQL 层只读白名单 (规则 1). Defaults to the union of declared tables. */
  observedTables?: string[];
  /** Opt in to the bundled fixture preset when the app declares no observers.
   * Only safe for callers that do NOT observe (static capability gating); a real
   * run must declare its own 口径 — see `resolveObserverConfig`. */
  allowBundledPreset?: boolean;
}

export interface SetupEnvOptions {
  runDir: string;
  seed: number;
  dataRoot: string;
  /** Roles whose accounts are seeded into the app via RC_SEED (规则 7:
   * seedRole "holder" occupies an initial slot; "none"/"waitlisted" do not). */
  roles?: Role[];
}

interface PageEntry {
  context: BrowserContext;
  page: Page;
}

interface Banner {
  dataResult: string | null;
  text: string;
}

const ADAPTER_VERSION = "0.1.0";
const REJECT_RE = /rejected|denied|full|已满|拒绝/i;
const TABLE_RE = /\b(?:from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/** 自带参考应用 booking-app 的观察器预设（**不是**通用能力）。
 *
 * 这里的 SQL 绑在该应用的 schema 上（course-1 主键、holder 种子账号）。它们能被
 * 复用是因为它们被声明成了预设，而不是因为适配器认识这张表 —— 接入新应用请提供
 * 自己的 observers（options / `reality-check.observers.json`），不要改适配器源码。 */
export const BOOKING_OBSERVERS: Record<string, ObserverSpec> = {
  "booking-count": {
    sql: "SELECT COUNT(*) AS n FROM bookings",
    tables: ["bookings"],
    columns: ["n"],
  },
  "capacity-left": {
    // Spec-intent semantics: capacity minus actual bookings for course-1.
    // (A literal `capacity - COUNT(*) ... FROM courses WHERE id = ...` would
    // only ever count the single courses row, never the bookings.)
    sql: "SELECT capacity - (SELECT COUNT(*) FROM bookings WHERE bookings.course_id = courses.id) AS left FROM courses WHERE id = 'course-1'",
    tables: ["courses", "bookings"],
    columns: ["left"],
  },
  "waitlist-head": {
    sql: "SELECT account FROM waitlist WHERE course_id = 'course-1' ORDER BY position ASC LIMIT 1",
    tables: ["waitlist"],
    columns: ["account"],
  },
  "waitlist-order": {
    sql: "SELECT account FROM waitlist WHERE course_id = 'course-1' ORDER BY position ASC",
    tables: ["waitlist"],
    columns: ["account"],
  },
  // String-valued observer for op "eqStr": who holds the promoted booking
  // (waitlist-order-wrong detection — 方案 §3.1 matrix).
  "booking-holder": {
    sql: "SELECT account FROM bookings WHERE course_id = 'course-1' AND account NOT IN ('holder_rc','holder2_rc') ORDER BY id ASC LIMIT 1",
    tables: ["bookings"],
    columns: ["account"],
  },
};

/** 自带参考应用 exam-seat-app 的观察器预设（同上：绑在该应用 schema 上）。 */
export const EXAM_OBSERVERS: Record<string, ObserverSpec> = {
  "seat-count": {
    sql: "SELECT COUNT(*) AS n FROM reservations",
    tables: ["reservations"],
    columns: ["n"],
  },
  "seats-left": {
    sql: "SELECT capacity - (SELECT COUNT(*) FROM reservations WHERE reservations.exam_id = exams.id) AS left FROM exams WHERE id = 'exam-1'",
    tables: ["exams", "reservations"],
    columns: ["left"],
  },
  // String-valued observer for op "eqStr": who holds the promoted reservation
  // (waitlist-order-wrong detection — 方案 §3.1 matrix).
  "reservation-holder": {
    sql: "SELECT account FROM reservations WHERE exam_id = 'exam-1' AND account NOT IN ('holder_rc','holder2_rc') ORDER BY id ASC LIMIT 1",
    tables: ["reservations"],
    columns: ["account"],
  },
};

/** 缺省预设 = 两个自带参考应用的并集。**仅供显式 opt-in 的静态用途**（例如 MCP 的
 * 能力门禁：那里不发生任何观察）。一次真实运行拿不到这套口径是有意为之——两个参考
 * 应用各自在 `fixtures/<app>/reality-check.observers.json` 里声明自己的口径，
 * 由 adapter.test.ts 钉住两份文件与常量一致。 */
export const BUNDLED_OBSERVERS: Record<string, ObserverSpec> = {
  ...BOOKING_OBSERVERS,
  ...EXAM_OBSERVERS,
};

const BUNDLED_OBSERVED_TABLES = [
  "courses",
  "bookings",
  "waitlist",
  "accounts",
  "exams",
  "reservations",
];

// --------------------------------------------------------- observer resolution

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/** 纯 SQL 标识符：表名/列名会被**拼接**进 dump 语句（`SELECT * FROM <table>`），
 * 不是参数化绑定，所以必须校验形状。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 规则 1「SQL 层只读」不只要校验表名，还要校验**语句类型**。
 *
 * 观察器口径现在由**应用配置**提供（不再写死在适配器源码里），信任边界因此变宽。
 * 实测：`db.prepare("INSERT INTO t VALUES (1)").all()` 返回 `[]`，但行真的写进了库。
 * 也就是说一条写语句会静默改写被测应用的状态——运行中被改状态，等于伪造结论，
 * 这是这个项目最不能接受的一类失败。`;`（多语句）同理。 */
function assertReadOnlySql(id: string, sql: string, source: string): void {
  const body = stripSqlComments(sql);
  if (body.includes(";"))
    throw new Error(
      `${source}: observer "${id}" sql must be a single statement (found ";"; read-only rule 规则 1)`,
    );
  if (!/^\s*(?:select|with)\b/i.test(body))
    throw new Error(
      `${source}: observer "${id}" sql must start with SELECT or WITH (read-only, 规则 1); got "${sql.trim().slice(0, 48)}"`,
    );
}

function assertIdentifiers(values: string[], what: string, id: string, source: string): void {
  for (const v of values) {
    if (!IDENT_RE.test(v))
      throw new Error(
        `${source}: observer "${id}" declares ${what} "${v}" which is not a plain SQL identifier`,
      );
  }
}

/** Validate + copy an observers record; every failure names the offending id. */
function normalizeObservers(input: unknown, source: string): Record<string, ObserverSpec> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error(`${source}: observers must be an object keyed by observer id`);
  const out: Record<string, ObserverSpec> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const o = raw as Partial<ObserverSpec> | null;
    if (typeof id !== "string" || id === "")
      throw new Error(`${source}: observer ids must be non-empty strings`);
    if (typeof o?.sql !== "string" || o.sql.trim() === "")
      throw new Error(`${source}: observer "${id}" needs a non-empty "sql"`);
    if (!isStringArray(o?.tables))
      throw new Error(`${source}: observer "${id}" needs "tables": non-empty string[]`);
    if (!isStringArray(o?.columns))
      throw new Error(`${source}: observer "${id}" needs "columns": non-empty string[]`);
    assertReadOnlySql(id, o.sql, source);
    assertIdentifiers(o.tables, "table", id, source);
    assertIdentifiers(o.columns, "column", id, source);
    out[id] = { sql: o.sql, tables: [...o.tables], columns: [...o.columns] };
  }
  if (Object.keys(out).length === 0)
    throw new Error(`${source}: observers must declare at least one observer`);
  return out;
}

function assertTablesDeclared(
  observers: Record<string, ObserverSpec>,
  observedTables: string[],
  source: string,
): void {
  // observedTables 会被拼进 dump 语句，先验形状再验归属。
  assertIdentifiers(observedTables, "table", "(observedTables)", source);
  for (const [id, o] of Object.entries(observers)) {
    for (const table of o.tables) {
      if (!observedTables.includes(table))
        throw new Error(
          `${source}: observer "${id}" declares table "${table}" which is not in observedTables [${observedTables.join(", ")}]`,
        );
    }
  }
}

/** Parse `{ observers, observedTables? }` (a bare record is accepted too). */
function parseObserversFile(raw: string, file: string): {
  observers: Record<string, ObserverSpec>;
  observedTables: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file}: expected a JSON object`);
  const obj = parsed as Record<string, unknown>;
  const hasWrapper = Object.prototype.hasOwnProperty.call(obj, "observers");
  const observers = normalizeObservers(hasWrapper ? obj["observers"] : obj, file);
  const declared = obj["observedTables"];
  if (declared !== undefined && !isStringArray(declared))
    throw new Error(`${file}: "observedTables" must be a non-empty string[]`);
  const observedTables =
    declared !== undefined ? [...declared] : [...new Set(Object.values(observers).flatMap((o) => o.tables))];
  assertTablesDeclared(observers, observedTables, file);
  return { observers, observedTables };
}

/** Options → app-dir config file → (only if explicitly allowed) bundled presets. */
function resolveObserverConfig(opts: LocalWebAdapterOptions): {
  observers: Record<string, ObserverSpec>;
  observedTables: string[];
} {
  if (opts.observers !== undefined) {
    const observers = normalizeObservers(opts.observers, "adapter options");
    if (opts.observedTables !== undefined && !isStringArray(opts.observedTables))
      throw new Error("adapter options: observedTables must be a non-empty string[]");
    const observedTables =
      opts.observedTables ?? [...new Set(Object.values(observers).flatMap((o) => o.tables))];
    assertTablesDeclared(observers, observedTables, "adapter options");
    return { observers, observedTables };
  }
  if (opts.observersFile !== undefined) {
    if (!fs.existsSync(opts.observersFile))
      throw new Error(`observers file not found: ${opts.observersFile}`);
    return parseObserversFile(fs.readFileSync(opts.observersFile, "utf8"), opts.observersFile);
  }
  const alongside = path.join(path.dirname(path.resolve(opts.appPath)), OBSERVERS_FILENAME);
  if (fs.existsSync(alongside))
    return parseObserversFile(fs.readFileSync(alongside, "utf8"), alongside);
  // 观察器口径必须由**应用**声明。但要区分两类缺失：
  //
  // 1. 应用入口**不存在** → 环境缺失。一次运行会以 blocked 结束（setupEnv 起不来），
  //    那才是真相；观察器在这里根本不会被用到，提前判成配置错误会把 blocked
  //    变成 exit 64，掩盖"应用没搭起来"这个真正的原因。
  // 2. 应用入口存在、却没有任何观察器声明 → 配置错误。这类"静默回退"最容易产出
  //    **自信的错误结论**：第三方应用只要有一张同名表（含义不同），就会用 fixture 的
  //    口径（course-1、holder_rc）给出一个看起来完全正常的结论。
  if (!fs.existsSync(opts.appPath))
    return { observers: { ...BUNDLED_OBSERVERS }, observedTables: [...BUNDLED_OBSERVED_TABLES] };
  if (opts.allowBundledPreset === true)
    return { observers: { ...BUNDLED_OBSERVERS }, observedTables: [...BUNDLED_OBSERVED_TABLES] };
  throw new Error(
    `no observers declared for app "${opts.appPath}": put ${OBSERVERS_FILENAME} next to the app entry, ` +
      `or set adapter.observers in the config, or pass options.observers ` +
      `(refusing to silently fall back to the bundled fixture preset — it would answer with another app's 口径)`,
  );
}

const SUPPORTED_OPS = [
  "navigate",
  "register",
  "login",
  "fill",
  "click",
  "submit",
  "wait",
  "barrier",
] as const;

const SUPPORTED_ASSERTIONS = ["eq", "ne", "gt", "gte", "lt", "lte", "countEq", "eqStr"] as const;

const EVIDENCE_KINDS: EvidenceKind[] = ["screenshot", "dom-snapshot", "page-text", "sql-dump"];

export class LocalWebAdapter {
  private readonly opts: LocalWebAdapterOptions;
  /** Resolved observers for THIS app (options > app-dir config > bundled). */
  private readonly observers: Record<string, ObserverSpec>;
  private readonly observedTables: string[];
  private browser: Browser | null = null;
  private child: ChildProcess | null = null;
  private readonly pages = new Map<string, PageEntry>();
  /** Set when Chromium disconnects mid-run — every later step must fail with
   * THIS reason instead of an anonymous "page has been closed" (归因要求). */
  private browserCrashReason: string | null = null;
  /** Set when the fixture app's PROCESS fails to start (spawn "error" event).
   * Never thrown from the listener — see `noteChildError`. */
  private childSpawnError: Error | null = null;
  private baseUrl = "";
  private dbPath: string | null = null;
  private dataRoot: string | null = null;
  private createdDataRoot = false;
  private dbCreated = false;
  private runDir: string | null = null;
  private seed = 0;
  private appVersion = "unknown";
  private stepCounter = 0;
  private obsCounter = 0;
  private evidenceSeq = 0;
  private tornDown = false;

  constructor(opts: LocalWebAdapterOptions) {
    this.opts = opts;
    const cfg = resolveObserverConfig(opts);
    this.observers = cfg.observers;
    this.observedTables = cfg.observedTables;
  }

  manifest(): AdapterManifest {
    return {
      protocol: { manifest: "1.0" },
      adapterId: "adapter-local-web",
      adapterVersion: ADAPTER_VERSION,
      // Serves 1.1 too: 1.1 only adds optional `when` steps and the `skipped`
      // outcome, both implemented by this adapter's kernel-side contract.
      scenarioVersion: "1.1",
      supportedOps: [...SUPPORTED_OPS],
      supportedAssertions: [...SUPPORTED_ASSERTIONS],
      observedTables: [...this.observedTables],
      evidenceKinds: [...EVIDENCE_KINDS],
      barriers: true,
      observers: { ...this.observers },
    };
  }

  async setupEnv(opts: SetupEnvOptions): Promise<EnvSummary> {
    if (!this.baseUrl) {
      this.runDir = opts.runDir;
      this.seed = opts.seed;
      await fsp.mkdir(opts.runDir, { recursive: true });
      await fsp.mkdir(path.join(opts.runDir, "evidence"), { recursive: true });

      const port = await getFreePort();
      this.baseUrl = `http://127.0.0.1:${port}`;
      this.createdDataRoot = !fs.existsSync(opts.dataRoot);
      await fsp.mkdir(opts.dataRoot, { recursive: true });
      this.dataRoot = opts.dataRoot;
      this.dbPath = path.join(opts.dataRoot, "app.db");
      // 所有权铁律: the app must never write into a DB file this run does not
      // own. If a file with our chosen name already exists, refuse — the
      // engine turns this into a blocked verdict, never a business result.
      if (fs.existsSync(this.dbPath)) {
        throw new Error(
          `database file "${this.dbPath}" already exists and is not owned by this run; refusing to start (方案 §10)`,
        );
      }
      this.dbCreated = true;

      const seedRoles = opts.roles ?? [];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RC_PORT: String(port),
        RC_DB: this.dbPath,
        RC_SEED: JSON.stringify(
          seedRoles.map((r) => ({
            username: r.account.username,
            password: r.account.password,
            seedRole: r.seedRole,
          })),
        ),
      };
      if (this.opts.faultEnv !== undefined && this.opts.faultEnv !== "") {
        env.RC_FAULT = this.opts.faultEnv;
      } else {
        delete env.RC_FAULT;
      }

      this.childSpawnError = null;
      this.child = spawn(process.execPath, [this.opts.appPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // 归因要求 (README「可归因的基础设施失败」): the spawn failure must not be
      // thrown here. This callback runs outside any call stack, so `throw` would
      // become an uncaught exception — the process dies without a `blocked`
      // event and without writing result.json, exactly the opposite of what the
      // contract promises. Record it; the health loop below converts it into a
      // normal setupEnv rejection (kernel -> blocked / exit 3).
      this.child.on("error", (err: unknown) => this.noteChildError(err));

      // Poll /healthz until 200 (15s timeout), parse {ok, app, version}.
      const deadline = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < deadline) {
        // Read through a method: a direct field read here would be narrowed to
        // `null` by the compiler (the listener's write is invisible to it).
        const spawnError = this.takeSpawnError();
        if (spawnError !== null) {
          await this.teardown();
          throw new Error(`fixture app process failed to start: ${spawnError.message}`);
        }
        try {
          const res = await fetch(`${this.baseUrl}/healthz`);
          if (res.ok) {
            const body = (await res.json()) as { ok?: boolean; app?: string; version?: string };
            if (body.ok === true) {
              this.appVersion = body.version ?? "unknown";
              healthy = true;
              break;
            }
          }
        } catch {
          // app not up yet; retry
        }
        await sleep(200);
      }
      if (!healthy) {
        await this.teardown();
        throw new Error(
          `fixture app ${this.opts.appPath} did not report healthy /healthz within 15s`,
        );
      }

      // Chromium 1194 is cached under %LOCALAPPDATA%\ms-playwright; resolve its
      // chrome.exe instead of letting playwright-core try to download browsers.
      const executablePath = findChromiumExecutable();
      // Backgrounded pages in a multi-context run get throttled by Chromium and
      // are the usual suspect when a page dies mid-scenario ("Target page,
      // context or browser has been closed"). These flags keep every role's
      // page live; the disconnect listener below makes a browser death
      // attributable instead of surfacing as an anonymous step error.
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-gpu",
          "--no-first-run",
        ],
        ...(executablePath ? { executablePath } : {}),
      });
      this.browser.on("disconnected", () => {
        // Never null the handle here: teardown still wants to try closing it,
        // and asserting the reason below is what makes the failure attributable.
        this.browserCrashReason =
          "Chromium disconnected mid-run (crash or killed) — 环境/工具失败，内核据此判 blocked，不是业务结论";
      });
    }

    const summary: EnvSummary = {
      appVersion: this.appVersion,
      adapterVersion: ADAPTER_VERSION,
      baseUrl: this.baseUrl,
      seed: this.seed,
      platform: process.platform,
    };
    if (this.dbPath) summary.dbPath = this.dbPath;
    return summary;
  }

  async registerAccounts(roles: Role[]): Promise<void> {
    this.assertUp();
    for (const role of roles) {
      const res = await fetch(`${this.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: role.account.username,
          password: role.account.password,
          seedRole: role.seedRole,
        }),
      });
      if (!res.ok) {
        throw new Error(
          `register account ${role.account.username} failed: HTTP ${res.status} ${await res
            .text()
            .catch(() => "")}`,
        );
      }
    }
  }

  async runStep(step: Step, _ctx: StepContext): Promise<Attempt> {
    const n = ++this.stepCounter;
    let attempt: Attempt;
    try {
      attempt = await this.executeStep(step);
    } catch (err) {
      attempt = {
        stepId: step.id,
        actor: step.actor,
        op: step.op,
        outcome: "error",
        detail: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    // 方案 §4: evidence is captured for EVERY step (including failed ones) and
    // the refs travel on the attempt so the kernel can verify + register them.
    const capture = await this.captureStepEvidence(step, n);
    if (capture.refs.length > 0) attempt.evidence = capture.refs;
    if (capture.error !== undefined)
      attempt.detail = { ...(attempt.detail ?? {}), evidenceError: capture.error };
    return attempt;
  }

  /** Arm all group steps, then submit them concurrently on different pages —
   * true contention (争抢同步屏障). Returns attempts in input order. */
  async runBarrier(steps: Step[], ctx: StepContext): Promise<Attempt[]> {
    const attempts: Attempt[] = new Array(steps.length);
    const deferred: { index: number; step: Step; n: number }[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as Step;
      const isFinalSubmit = step.op === "submit" || (step.op === "click" && step.barrier === true);
      if (isFinalSubmit) {
        deferred.push({ index: i, step, n: ++this.stepCounter });
        continue;
      }
      attempts[i] = await this.runStep(step, ctx);
    }
    const settled = await Promise.all(
      deferred.map(async ({ step }) => {
        try {
          return await this.performSubmit(step);
        } catch (err) {
          return {
            stepId: step.id,
            actor: step.actor,
            op: step.op,
            outcome: "error" as const,
            detail: { error: err instanceof Error ? err.message : String(err) },
          };
        }
      }),
    );
    for (let k = 0; k < deferred.length; k++) {
      const d = deferred[k] as { index: number; step: Step; n: number };
      const target = settled[k] as Attempt;
      attempts[d.index] = target;
      const capture = await this.captureStepEvidence(d.step, d.n);
      if (capture.refs.length > 0) target.evidence = capture.refs;
      if (capture.error !== undefined)
        target.detail = { ...(target.detail ?? {}), evidenceError: capture.error };
    }
    return attempts;
  }

  async observe(observerId: string): Promise<ObserverReading> {
    this.assertUp();
    const def = this.manifest().observers[observerId];
    if (!def) {
      throw new Error(
        `unknown observer "${observerId}"; known: ${Object.keys(this.observers).join(", ")}`,
      );
    }
    // SQL 层只读 (规则 1): 语句类型 + 表名都必须在配置层被拒过一次。运行时再验一次，
    // 因为 manifest() 是对外暴露的静态元数据，spec 可能来自自定义适配器而不是配置文件。
    assertReadOnlySql(observerId, def.sql, "runtime");
    for (const match of def.sql.matchAll(TABLE_RE)) {
      const table = match[1];
      if (!table || !this.observedTables.includes(table)) {
        throw new Error(
          `observer "${observerId}" touches table "${String(table)}" outside observedTables whitelist`,
        );
      }
    }
    if (!this.dbPath) throw new Error("setupEnv has not been called");

    // Fresh connection per read — WAL visibility comes from a new connection,
    // never from readOnly flags or a long-lived snapshot (规则 1).
    const db = new DatabaseSync(this.dbPath);
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(def.sql).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }

    const n = ++this.obsCounter;
    const file = path.join(this.runDir ?? ".", "evidence", `obs-${observerId}-${n}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ sql: def.sql, rows }, null, 2), "utf8");
    const ref: EvidenceRef = {
      kind: "sql-dump",
      file: toRel(this.runDir ?? ".", file),
      seq: ++this.evidenceSeq,
      sha256: await sha256File(file),
    };
    return { observerId, columns: [...def.columns], rows, evidence: [ref] };
  }

  async captureEvidence(kind: EvidenceKind, actor?: string): Promise<EvidenceRef> {
    this.assertUp();
    if (!EVIDENCE_KINDS.includes(kind)) {
      throw new Error(`evidence kind "${kind}" is not produced by this adapter`);
    }
    const n = ++this.evidenceSeq;
    const evidenceDir = path.join(this.runDir ?? ".", "evidence");
    await fsp.mkdir(evidenceDir, { recursive: true });
    const suffix = actor ?? "app";
    let file: string;

    if (kind === "sql-dump") {
      if (!this.dbPath) throw new Error("setupEnv has not been called");
      const dump: Record<string, unknown[]> = {};
      const db = new DatabaseSync(this.dbPath);
      try {
        for (const table of this.observedTables) {
          dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
        }
      } finally {
        db.close();
      }
      file = path.join(evidenceDir, `ev-${n}-${suffix}.sql.json`);
      await fsp.writeFile(file, JSON.stringify(dump, null, 2), "utf8");
    } else {
      const page = this.pages.get(actor ?? "")?.page ?? this.onlyPage();
      if (!page) throw new Error(`no page for actor "${String(actor)}" to capture ${kind} from`);
      if (kind === "screenshot") {
        file = path.join(evidenceDir, `ev-${n}-${suffix}.png`);
        await page.screenshot({ path: file, fullPage: true });
      } else if (kind === "dom-snapshot") {
        file = path.join(evidenceDir, `ev-${n}-${suffix}.dom.html`);
        await fsp.writeFile(file, await page.content(), "utf8");
      } else {
        // page-text
        file = path.join(evidenceDir, `ev-${n}-${suffix}.txt`);
        await fsp.writeFile(file, await page.innerText("body"), "utf8");
      }
    }

    const ref: EvidenceRef = {
      kind,
      file: toRel(this.runDir ?? ".", file),
      seq: n,
      sha256: await sha256File(file),
    };
    if (actor !== undefined) ref.actor = actor;
    return ref;
  }

  /** Kill the app, close the browser, delete the DB and data-root content we
   * created. Idempotent; returns torn-down paths. */
  async teardown(): Promise<string[]> {
    const removed: string[] = [];
    if (this.tornDown) return removed;
    this.tornDown = true;

    if (this.child) {
      const child = this.child;
      this.child = null;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      await Promise.race([exited, sleep(3000)]);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => {});
    }
    this.pages.clear();

    if (this.dbPath && this.dbCreated) {
      for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        await fsp.rm(f, { force: true });
      }
      removed.push(this.dbPath);
    }
    this.dbPath = null;
    this.dbCreated = false;
    if (this.dataRoot && this.createdDataRoot) {
      await fsp.rm(this.dataRoot, { recursive: true, force: true });
      removed.push(this.dataRoot);
    }
    this.baseUrl = "";
    return removed;
  }

  // ------------------------------------------------------------------ internals

  /** Single place where a fixture-process spawn failure becomes attributable
   * state (called by the child's "error" listener).
   *
   * Public by design: a real spawn failure cannot be reproduced on demand, so
   * tests drive this method directly and assert the surfacing contract
   * (no throw out of the listener, an attributable message in `detail.error`). */
  noteChildError(err: unknown): void {
    this.childSpawnError = err instanceof Error ? err : new Error(String(err));
  }

  private takeSpawnError(): Error | null {
    return this.childSpawnError;
  }

  private assertUp(): void {
    if (this.childSpawnError !== null)
      throw new Error(`fixture app process failed: ${this.childSpawnError.message}`);
    if (this.browserCrashReason !== null) throw new Error(this.browserCrashReason);
    if (!this.baseUrl || !this.browser) {
      throw new Error("adapter environment is not up; call setupEnv first");
    }
  }

  private onlyPage(): Page | null {
    for (const entry of this.pages.values()) return entry.page;
    return null;
  }

  private async ensurePage(actor: string): Promise<Page> {
    this.assertUp();
    let entry = this.pages.get(actor);
    if (!entry) {
      // ONE browser context per role — multi-account isolation.
      const context = await this.browser!.newContext();
      const page = await context.newPage();
      entry = { context, page };
      this.pages.set(actor, entry);
    } else if (entry.page.isClosed()) {
      // A renderer crash closes the page but keeps the browser handle alive
      // (Playwright would otherwise report only "page has been closed").
      throw new Error(
        `actor "${actor}" lost its page mid-run (renderer crash or external close) — 环境/工具失败，内核据此判 blocked`,
      );
    }
    return entry.page;
  }

  private async executeStep(step: Step): Promise<Attempt> {
    const base = { stepId: step.id, actor: step.actor, op: step.op };
    const page = await this.ensurePage(step.actor);
    switch (step.op) {
      case "navigate": {
        const target = this.baseUrl + String(step.params?.path ?? "/");
        await page.goto(target, { waitUntil: "networkidle", timeout: 15_000 });
        return { ...base, outcome: "completed", detail: { url: page.url() } };
      }
      case "register":
      case "login": {
        const target = this.baseUrl + (step.op === "register" ? "/register" : "/login");
        await page.goto(target, { waitUntil: "networkidle", timeout: 15_000 });
        await page.fill("#username", String(step.params?.username ?? ""));
        await page.fill("#password", String(step.params?.password ?? ""));
        await page.click("button[type=submit]");
        await page.waitForLoadState("networkidle");
        const banner = await readBanner(page);
        return {
          ...base,
          outcome: isRejected(banner) ? "rejected" : "completed",
          detail: { url: page.url(), banner: banner.text },
        };
      }
      case "fill": {
        await page.fill(String(step.params?.selector), String(step.params?.value ?? ""));
        return { ...base, outcome: "completed", detail: { url: page.url() } };
      }
      case "click": {
        await page.click(String(step.params?.selector ?? "button[type=submit]"));
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        return { ...base, outcome: "completed", detail: { url: page.url() } };
      }
      case "submit":
        return this.performSubmit(step);
      case "wait": {
        await sleep(Number(step.params?.ms ?? 0));
        return { ...base, outcome: "completed", detail: { url: page.url() } };
      }
      case "barrier":
        // No-op: real concurrency happens in runBarrier().
        return { ...base, outcome: "completed", detail: { url: page.url() } };
    }
  }

  /** Click a submit button and honestly classify what happened (规则 6: no
   * navigation => "no-nav", never a silent success). */
  private async performSubmit(step: Step): Promise<Attempt> {
    const base = { stepId: step.id, actor: step.actor, op: step.op };
    const page = await this.ensurePage(step.actor);
    const selector = String(step.params?.selector ?? "button[type=submit]");
    const navigated = page
      .waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 8_000,
      })
      .then(
        () => true,
        () => false,
      );
    await page.click(selector);
    const didNavigate = await navigated;
    if (!didNavigate) {
      return { ...base, outcome: "no-nav", detail: { url: page.url() } };
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const banner = await readBanner(page);
    return {
      ...base,
      outcome: isRejected(banner) ? "rejected" : "completed",
      detail: { url: page.url(), banner: banner.text },
    };
  }

  /** Per-step evidence: screenshot + DOM snapshot land on disk immediately. */
  /** Capture the step's screenshot + DOM snapshot and return their refs.
   *
   * Never throws: a partially captured step keeps the refs of the files that
   * DID land (evidence of a half-failed step is still evidence), and the
   * failure is reported back as `error` so the kernel can surface it instead of
   * silently weakening the completeness guarantee (方案 §4 铁律 3).
   * Returns empty refs when the actor has no page yet (nothing to look at). */
  private async captureStepEvidence(
    step: Step,
    n: number,
  ): Promise<{ refs: EvidenceRef[]; error?: string }> {
    const entry = this.pages.get(step.actor);
    const runDir = this.runDir;
    if (!entry || !runDir) return { refs: [] };
    const evidenceDir = path.join(runDir, "evidence");
    const stem = path.join(evidenceDir, `step-${n}-${step.actor}`);
    const refs: EvidenceRef[] = [];
    const errors: string[] = [];
    const register = async (kind: EvidenceKind, file: string): Promise<void> => {
      const ref: EvidenceRef = {
        kind,
        file: toRel(runDir, file),
        seq: ++this.evidenceSeq,
        actor: step.actor,
        sha256: await sha256File(file),
      };
      refs.push(ref);
    };
    try {
      await fsp.mkdir(evidenceDir, { recursive: true });
      const png = `${stem}.png`;
      await entry.page.screenshot({ path: png, fullPage: true });
      await register("screenshot", png);
    } catch (e) {
      errors.push(`screenshot: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await fsp.mkdir(evidenceDir, { recursive: true });
      const dom = `${stem}.dom.html`;
      await fsp.writeFile(dom, await entry.page.content(), "utf8");
      await register("dom-snapshot", dom);
    } catch (e) {
      errors.push(`dom-snapshot: ${e instanceof Error ? e.message : String(e)}`);
    }
    return errors.length > 0 ? { refs, error: errors.join("; ") } : { refs };
  }
}

export function createLocalWebAdapter(opts: LocalWebAdapterOptions): LocalWebAdapter {
  return new LocalWebAdapter(opts);
}

// -------------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to probe a free port")));
      }
    });
  });
}

/** Resolve chrome.exe from the cached %LOCALAPPDATA%\ms-playwright chromium-1194
 * build; never trigger a browser download. */
function findChromiumExecutable(): string | undefined {
  const base = path.join(process.env["LOCALAPPDATA"] ?? "", "ms-playwright", "chromium-1194");
  if (!fs.existsSync(base)) return undefined;
  for (const entry of fs.readdirSync(base)) {
    if (!entry.startsWith("chrome-win")) continue;
    const candidate = path.join(base, entry, "chrome.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function readBanner(page: Page): Promise<Banner> {
  const el = page.locator("#result");
  const dataResult = await el.getAttribute("data-result").catch(() => null);
  const text = (await el.textContent().catch(() => null)) ?? "";
  return { dataResult, text: text.trim() };
}

function isRejected(banner: Banner): boolean {
  if (banner.dataResult === "rejected") return true;
  return REJECT_RE.test(banner.text);
}

function toRel(runDir: string, file: string): string {
  return path.relative(runDir, file).split(path.sep).join("/");
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}
