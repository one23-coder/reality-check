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

export interface LocalWebAdapterOptions {
  /** Absolute or cwd-relative path to the fixture app entry (node script). */
  appPath: string;
  /** Value for the app's RC_FAULT env; omit/empty to run a correct app. */
  faultEnv?: string;
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

/** Adapter-provided observers — literal SQL, named exactly (断言主体复用这些口径). */
const OBSERVERS: Record<string, { sql: string; tables: string[]; columns: string[] }> = {
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
  // String-valued observers for op "eqStr": who holds the promoted booking /
  // reservation (waitlist-order-wrong detection — 方案 §3.1 matrix).
  "booking-holder": {
    sql: "SELECT account FROM bookings WHERE course_id = 'course-1' AND account NOT IN ('holder_rc','holder2_rc') ORDER BY id ASC LIMIT 1",
    tables: ["bookings"],
    columns: ["account"],
  },
  "reservation-holder": {
    sql: "SELECT account FROM reservations WHERE exam_id = 'exam-1' AND account NOT IN ('holder_rc','holder2_rc') ORDER BY id ASC LIMIT 1",
    tables: ["reservations"],
    columns: ["account"],
  },
};

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

const OBSERVED_TABLES = [
  "courses",
  "bookings",
  "waitlist",
  "accounts",
  "exams",
  "reservations",
] as const;

const EVIDENCE_KINDS: EvidenceKind[] = ["screenshot", "dom-snapshot", "page-text", "sql-dump"];

export class LocalWebAdapter {
  private readonly opts: LocalWebAdapterOptions;
  private browser: Browser | null = null;
  private child: ChildProcess | null = null;
  private readonly pages = new Map<string, PageEntry>();
  private baseUrl = "";
  private dbPath: string | null = null;
  private dataRoot: string | null = null;
  private createdDataRoot = false;
  private runDir: string | null = null;
  private seed = 0;
  private appVersion = "unknown";
  private stepCounter = 0;
  private obsCounter = 0;
  private evidenceSeq = 0;
  private tornDown = false;

  constructor(opts: LocalWebAdapterOptions) {
    this.opts = opts;
  }

  manifest(): AdapterManifest {
    return {
      protocol: { manifest: "1.0" },
      adapterId: "adapter-local-web",
      adapterVersion: ADAPTER_VERSION,
      scenarioVersion: "1.0",
      supportedOps: [...SUPPORTED_OPS],
      supportedAssertions: [...SUPPORTED_ASSERTIONS],
      observedTables: [...OBSERVED_TABLES],
      evidenceKinds: [...EVIDENCE_KINDS],
      barriers: true,
      observers: OBSERVERS,
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

      this.child = spawn(process.execPath, [this.opts.appPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child.on("error", (err) => {
        throw err;
      });

      // Poll /healthz until 200 (15s timeout), parse {ok, app, version}.
      const deadline = Date.now() + 15_000;
      let healthy = false;
      while (Date.now() < deadline) {
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
      this.browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
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
    await this.captureStepEvidence(step, n).catch(() => {});
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
      attempts[d.index] = settled[k] as Attempt;
      await this.captureStepEvidence(d.step, d.n).catch(() => {});
    }
    return attempts;
  }

  async observe(observerId: string): Promise<ObserverReading> {
    this.assertUp();
    const def = this.manifest().observers[observerId];
    if (!def) {
      throw new Error(`unknown observer "${observerId}"; known: ${Object.keys(OBSERVERS).join(", ")}`);
    }
    // SQL 层只读白名单 (规则 1): every table named in the SQL must be declared.
    for (const match of def.sql.matchAll(TABLE_RE)) {
      const table = match[1];
      if (!table || !OBSERVED_TABLES.includes(table as (typeof OBSERVED_TABLES)[number])) {
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
        for (const table of OBSERVED_TABLES) {
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

    if (this.dbPath) {
      for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        await fsp.rm(f, { force: true });
      }
      removed.push(this.dbPath);
      this.dbPath = null;
    }
    if (this.dataRoot && this.createdDataRoot) {
      await fsp.rm(this.dataRoot, { recursive: true, force: true });
      removed.push(this.dataRoot);
    }
    this.baseUrl = "";
    return removed;
  }

  // ------------------------------------------------------------------ internals

  private assertUp(): void {
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
  private async captureStepEvidence(step: Step, n: number): Promise<void> {
    const entry = this.pages.get(step.actor);
    if (!entry || !this.runDir) return;
    const evidenceDir = path.join(this.runDir, "evidence");
    await fsp.mkdir(evidenceDir, { recursive: true });
    const stem = path.join(evidenceDir, `step-${n}-${step.actor}`);
    await entry.page.screenshot({ path: `${stem}.png`, fullPage: true });
    await fsp.writeFile(`${stem}.dom.html`, await entry.page.content(), "utf8");
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
