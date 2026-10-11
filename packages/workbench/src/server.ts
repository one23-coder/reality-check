/** 本地演练工作台 HTTP 服务 (方案 §6 阶段 2).
 *
 * Plain node:http (no framework). Every run goes THROUGH THE SAME KERNEL as
 * the CLI: executeScenario() from @rc/core + createLocalWebAdapter() from
 * @rc/adapter-local-web, artifacts in the shared runs layout, reports from
 * @rc/reporter, drafts from @rc/planner. The workbench adds NO execution,
 * assertion, or reporting logic of its own.
 *
 * Endpoints:
 *   GET  /                      workbench UI (self-contained HTML)
 *   GET  /api/scenarios         list scenariosDir entries
 *   GET  /api/scenario/:id      full scenario JSON
 *   POST /api/run               run through the kernel (seed/fault/overrides)
 *   GET  /api/runs              list runs (desc by startedAt)
 *   GET  /api/run/:id           result.json + events.jsonl + htmlPath
 *   POST /api/draft             planScenario -> scenario DRAFT (never saved)
 *   GET  /runs/:id/evidence/:f  run artifacts (path-traversal guarded)
 */
import http from "node:http";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICT_EXIT, type RunResult, type Scenario, type TimelineEvent } from "@rc/protocol";
import { executeScenario, isRunError } from "@rc/core";
import { createLocalWebAdapter, type LocalWebAdapterOptions } from "@rc/adapter-local-web";
import { renderHtmlReport, renderJsonReport } from "@rc/reporter";
import { planScenario } from "@rc/planner";
import { applyOverrides, buildDraft, looksLikeInjection, OverrideError, type RunOverrides } from "./overrides.js";
import { listRuns, listScenarios, loadScenarioById, readRunDetail } from "./store.js";

export const DEFAULT_PORT = 7788;
export const DEFAULT_HOST = "127.0.0.1";

export interface WorkbenchOptions {
  /** Listen port; default 7788. Use 0 for an ephemeral port (tests). */
  port?: number;
  /** Bind host; default 127.0.0.1 (本地工具, 不对外暴露). */
  host?: string;
  /** Directory that receives runsDir/<runId>/ artifacts. */
  runsDir: string;
  /** Directory holding <scenarioId>.json files. */
  scenariosDir: string;
  /** Fixture app entry passed to createLocalWebAdapter (same as CLI config app.entry). */
  appPath: string;
}

export interface WorkbenchServer {
  port: number;
  close(): Promise<void>;
}

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATIC_DIR = path.join(PKG_ROOT, "src", "static");

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".har": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** One browser run at a time — heavy on resources; serialize for stability. */
function createRunQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
}

async function serveFile(res: http.ServerResponse, file: string, guardRoot: string): Promise<void> {
  // Path-traversal guard: the resolved target MUST stay inside guardRoot.
  const root = path.resolve(guardRoot);
  const target = path.resolve(file);
  if (target !== root && !target.startsWith(root + path.sep)) {
    json(res, 403, { error: "path escapes runs directory" });
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    json(res, 404, { error: "not found" });
    return;
  }
  if (!stat.isFile()) {
    json(res, 404, { error: "not found" });
    return;
  }
  const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(await fsp.readFile(target));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface RunRequestBody {
  scenarioId?: unknown;
  seed?: unknown;
  fault?: unknown;
  overrides?: unknown;
}

/** POST /api/run — load scenario, apply overrides (validated BEFORE the run),
 * then executeScenario through the real kernel + real adapter + reports. */
async function handleRun(
  opts: WorkbenchOptions,
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { status: 400, payload: { error: "request body must be a JSON object" } };
  const req = body as RunRequestBody;
  if (typeof req.scenarioId !== "string" || req.scenarioId === "")
    return { status: 400, payload: { error: "scenarioId is required" } };

  let scenario: Scenario;
  try {
    scenario = await loadScenarioById(opts.scenariosDir, req.scenarioId);
  } catch (e) {
    return { status: 404, payload: { error: `scenario not found: ${msg(e)}` } };
  }

  if (req.overrides !== undefined) {
    try {
      scenario = applyOverrides(scenario, req.overrides as RunOverrides);
    } catch (e) {
      if (e instanceof OverrideError)
        return { status: 400, payload: { error: e.message } };
      // Rejected override -> the validator's error verbatim (方案 §6: 被拒时给出可修的错误).
      return { status: 400, payload: { error: `invalid overrides: ${msg(e)}` } };
    }
  }

  // 非法 seed/fault 必须报错，不能悄悄按默认值跑：用户看到 200 + verdict 会以为
//  这是"指定种子下的结论"，随后复跑对不上，结论就失去了可归因性。
  if (req.fault !== undefined && typeof req.fault !== "string")
    return { status: 400, payload: { error: `invalid fault: expected a string, got ${typeof req.fault}` } };
  if (req.seed !== undefined && !Number.isInteger(req.seed))
    return {
      status: 400,
      payload: { error: `invalid seed: expected an integer, got ${JSON.stringify(req.seed)}` },
    };

  const adapterOpts: LocalWebAdapterOptions = { appPath: opts.appPath };
  if (typeof req.fault === "string" && req.fault !== "") adapterOpts.faultEnv = req.fault;

  const execOpts: { runsRoot: string; seed?: number } = { runsRoot: opts.runsDir };
  if (typeof req.seed === "number" && req.seed >= 0) execOpts.seed = req.seed;

  let result: RunResult;
  try {
    result = await executeScenario(scenario, createLocalWebAdapter(adapterOpts), execOpts);
  } catch (e) {
    if (isRunError(e))
      return {
        status: e.kind === "config" ? 400 : 500,
        payload: { error: e.message, exitCode: e.exitCode },
      };
    return { status: 500, payload: { error: `kernel failure: ${msg(e)}` } };
  }

  // 运行产物布局必须与 CLI 一致（docs/protocol-reference.md §产物）：侧车 + 报告。
  // 少了 cli.json，工作台跑出来的 run 就 rerun 不掉、export --pack 也退化成模式规则，
  // "三入口一致"在这里就不成立。写入失败同样不能吞掉结论（与 CLI 同一口径）。
  const runDir = path.join(opts.runsDir, result.runId);
  const warnings: string[] = [];
  try {
    const events: TimelineEvent[] = result.timeline;
    await fsp.writeFile(
      path.join(runDir, "cli.json"),
      JSON.stringify(
        { scenarioPath: path.resolve(opts.scenariosDir, `${req.scenarioId}.json`), seed: result.seed },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(path.join(runDir, "report.json"), renderJsonReport(result, events), "utf8");
    await fsp.writeFile(path.join(runDir, "report.html"), renderHtmlReport(result, events), "utf8");
  } catch (e) {
    warnings.push(
      `结论已落盘（${path.join(runDir, "result.json")}），但侧车/报告写入失败：${msg(e)}`,
    );
  }

  return {
    status: 200,
    payload: {
      runId: result.runId,
      verdict: result.verdict,
      exitCode: VERDICT_EXIT[result.verdict],
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function startWorkbench(opts: WorkbenchOptions): Promise<WorkbenchServer> {
  const enqueue = createRunQueue();
  const runsRoot = path.resolve(opts.runsDir);
  const server = http.createServer((req, res) => {
    handle(opts, { enqueue, runsRoot }, req, res).catch((e) => {
      json(res, 500, { error: `internal error: ${msg(e)}` });
    });
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? DEFAULT_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : DEFAULT_PORT;
      resolvePromise({
        port,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

async function handle(
  opts: WorkbenchOptions,
  ctx: { enqueue: <T>(task: () => Promise<T>) => Promise<T>; runsRoot: string },
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Parse req.url manually (no URL normalization): "/runs/../x" must reach the
  // traversal guard as-is instead of being collapsed to "/x".
  const raw = req.url ?? "/";
  const qIdx = raw.indexOf("?");
  const pathname = decodeURIComponent(qIdx >= 0 ? raw.slice(0, qIdx) : raw);
  const method = req.method ?? "GET";

  // ---- UI ------------------------------------------------------------
  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    await serveFile(res, path.join(STATIC_DIR, "index.html"), STATIC_DIR);
    return;
  }

  // ---- scenarios -----------------------------------------------------
  if (method === "GET" && pathname === "/api/scenarios") {
    json(res, 200, await listScenarios(opts.scenariosDir));
    return;
  }

  if (method === "GET" && pathname.startsWith("/api/scenario/")) {
    const id = pathname.slice("/api/scenario/".length);
    try {
      const scenario = await loadScenarioById(opts.scenariosDir, id);
      json(res, 200, scenario);
    } catch (e) {
      json(res, 404, { error: msg(e) });
    }
    return;
  }

  // ---- run (same kernel as CLI) --------------------------------------
  if (method === "POST" && pathname === "/api/run") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 400, { error: `invalid JSON body: ${msg(e)}` });
      return;
    }
    const out = await ctx.enqueue(() => handleRun(opts, body));
    json(res, out.status, out.payload);
    return;
  }

  // ---- run records ----------------------------------------------------
  if (method === "GET" && pathname === "/api/runs") {
    json(res, 200, await listRuns(opts.runsDir));
    return;
  }

  if (method === "GET" && pathname.startsWith("/api/run/")) {
    const runId = pathname.slice("/api/run/".length);
    const detail = await readRunDetail(opts.runsDir, runId);
    if (detail === undefined) {
      json(res, 404, { error: `run "${runId}" not found (no result.json)` });
      return;
    }
    json(res, 200, detail);
    return;
  }

  // ---- draft (planner; never auto-saved) ------------------------------
  if (method === "POST" && pathname === "/api/draft") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 400, { error: `invalid JSON body: ${msg(e)}` });
      return;
    }
    const text = typeof body === "object" && body !== null
      ? (body as { text?: unknown }).text
      : undefined;
    if (typeof text !== "string" || text.trim() === "") {
      json(res, 400, { error: "text is required" });
      return;
    }
    if (looksLikeInjection(text)) {
      json(res, 422, { rejected: "injection-guard" });
      return;
    }
    const saved = (await listScenarios(opts.scenariosDir)).filter((s) => s.error === undefined);
    let scenarios: Scenario[];
    try {
      scenarios = await Promise.all(saved.map((s) => loadScenarioById(opts.scenariosDir, s.id)));
    } catch (e) {
      json(res, 500, { error: `loading saved scenarios failed: ${msg(e)}` });
      return;
    }
    if (scenarios.length === 0) {
      json(res, 400, { error: "no saved scenarios available for drafting" });
      return;
    }
    try {
      const decision = await planScenario({ request: text, savedScenarios: scenarios });
      // 规则 9: no category clue and no usable model -> NO scenario is chosen;
      // never fabricate a draft from a guessed default.
      if (decision.scenario === undefined) {
        json(res, 422, {
          rejected: "needs-model",
          decision: {
            fallback: decision.fallback,
            needsModel: decision.needsModel,
            reason: decision.reason,
            params: decision.params,
          },
        });
        return;
      }
      const built = buildDraft({ scenario: decision.scenario });
      const payload: Record<string, unknown> = {
        isDraft: true,
        draft: built.draft,
        decision: {
          fallback: decision.fallback,
          needsModel: decision.needsModel,
          reason: decision.reason,
          params: decision.params,
        },
        valid: built.valid,
      };
      if (!built.valid) payload.errors = built.errors;
      json(res, 200, payload);
    } catch (e) {
      json(res, 400, { error: msg(e) });
    }
    return;
  }

  // ---- run artifacts (guarded static) ----------------------------------
  if (method === "GET" && pathname.startsWith("/runs/")) {
    const rest = pathname.slice("/runs/".length);
    const slash = rest.indexOf("/");
    const runId = slash >= 0 ? rest.slice(0, slash) : rest;
    const artifact = slash >= 0 ? rest.slice(slash + 1) : "";
    if (runId === "" || artifact === "") {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..")) {
      json(res, 403, { error: "invalid run id" });
      return;
    }
    if (artifact.startsWith("evidence/")) {
      await serveFile(res, path.join(ctx.runsRoot, runId, artifact), ctx.runsRoot);
      return;
    }
    if (artifact === "report.html" || artifact === "report.json") {
      await serveFile(res, path.join(ctx.runsRoot, runId, artifact), ctx.runsRoot);
      return;
    }
    json(res, 404, { error: "not found" });
    return;
  }

  json(res, 404, { error: `no route: ${method} ${pathname}` });
}

/** Ensure the static UI exists (fail fast at startup, not per request). */
export function assertStaticUi(): void {
  if (!fs.existsSync(path.join(STATIC_DIR, "index.html")))
    throw new Error(`workbench UI missing at ${path.join(STATIC_DIR, "index.html")}`);
}
