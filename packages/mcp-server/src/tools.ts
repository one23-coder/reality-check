/** Tool implementations (阶段3 §7: 编程助手可检查项目、运行、读结果、复验).
 *
 * rc_run goes through the SAME call path as the CLI runner
 * (packages/cli/src/runner.ts runOnce): loadScenarioFile -> createLocalWebAdapter
 * -> executeScenario(@rc/core) -> sidecar meta file. Differences are additive
 * only: the sidecar is `mcp.json` (same shape as `cli.json`), and reports are
 * NOT rendered here (reporter stays an optional concern; rc_get_result serves
 * the structured result). Verdicts (passed/failed/blocked/inconclusive) are
 * RESULTS, never tool errors — a blocked/inconclusive run is not a product
 * bug (方案 §7: CI 不把环境缺失计为产品 bug，也不假装通过). Only config-class
 * failures (invalid scenario, missing run, RunError 64/70) become
 * isError:true.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  EXIT_DESCRIPTION,
  VERDICT_EXIT,
  explainResult,
  type RunResult,
  type TimelineEvent,
} from "@rc/protocol";
import { executeScenario, isRunError } from "@rc/core";
import { createLocalWebAdapter } from "@rc/adapter-local-web";
import type { McpConfig } from "./config.js";
import { ToolError, checkScenario, loadScenarioFile } from "./capabilities.js";

export interface ToolResult {
  /** Structured payload, serialized as the single text content block. */
  payload: unknown;
  /** True only for config-class failures; verdicts never set this. */
  isError?: boolean;
}

/** Sidecar for rc_rerun — core's run.json intentionally does not carry the
 * scenario path, so this records it (parity with cli.json). */
export interface McpRunMeta {
  scenarioPath: string;
  seed: number;
  previousRunId?: string;
}

export const MCP_META_FILE = "mcp.json";

function metaPath(config: McpConfig, runId: string): string {
  return path.join(config.runsDir, runId, MCP_META_FILE);
}

/** runId comes from the network-facing tool surface; keep it a single path
 * segment so it can never traverse out of runsDir. */
function assertSafeRunId(runId: string): void {
  if (runId === "" || /[/\\]/.test(runId) || runId === "." || runId === "..") {
    throw new ToolError(`invalid runId: ${JSON.stringify(runId)}`);
  }
}

function ruleSummary(result: RunResult): {
  total: number;
  held: number;
  violated: number;
  inconclusive: number;
  notEvaluated: number;
} {
  const summary = { total: 0, held: 0, violated: 0, inconclusive: 0, notEvaluated: 0 };
  for (const e of result.ruleEvaluations) {
    summary.total++;
    if (e.verdict === "held") summary.held++;
    else if (e.verdict === "violated") summary.violated++;
    else if (e.verdict === "inconclusive") summary.inconclusive++;
    else summary.notEvaluated++;
  }
  return summary;
}

// ------------------------------------------------------------------ rc_check

export async function toolCheck(
  config: McpConfig,
  args: { scenarioPath?: unknown },
): Promise<ToolResult> {
  if (typeof args.scenarioPath !== "string" || args.scenarioPath === "") {
    throw new ToolError("rc_check requires string argument: scenarioPath");
  }
  return {
    payload: checkScenario(args.scenarioPath, config.appEntry),
  };
}

// -------------------------------------------------------------------- rc_run

/** Shared execution path for rc_run and rc_rerun (mirrors cli runOnce). */
async function runScenario(
  config: McpConfig,
  scenarioPath: string,
  seed: number | undefined,
  fault: string | undefined,
  previousRunId: string | undefined,
): Promise<ToolResult> {
  if (config.appEntry === undefined) {
    throw new ToolError(
      "no app entry configured: set app.entry in .reality-check.json or the appEntry option",
    );
  }
  const scenario = loadScenarioFile(scenarioPath);

  const adapterOpts: { appPath: string; faultEnv?: string } = { appPath: config.appEntry };
  const faultEnv = fault ?? config.faultEnv;
  if (faultEnv !== undefined && faultEnv !== "") adapterOpts.faultEnv = faultEnv;
  const adapter = createLocalWebAdapter(adapterOpts);

  const execOpts: { runsRoot: string; seed?: number } = { runsRoot: config.runsDir };
  if (seed !== undefined) execOpts.seed = seed;

  let result: RunResult;
  try {
    result = await executeScenario(scenario, adapter, execOpts);
  } catch (e) {
    // RunError kinds map verbatim onto the exit-code contract:
    // kind "config" -> 64, kind "internal" -> 70. Verdicts (0/1/2/3) never
    // come through here.
    if (isRunError(e)) {
      throw new ToolError(`[${e.kind}] (exit ${e.exitCode}) ${e.message}`);
    }
    throw new ToolError(
      `internal error: executeScenario failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const runDir = path.join(config.runsDir, result.runId);
  const meta: McpRunMeta = { scenarioPath: path.resolve(scenarioPath), seed: result.seed };
  if (previousRunId !== undefined) meta.previousRunId = previousRunId;
  try {
    await fsp.writeFile(metaPath(config, result.runId), JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    throw new ToolError(
      `run ${result.runId} finished but its sidecar could not be written: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return {
    payload: {
      runId: result.runId,
      verdict: result.verdict,
      exitCode: VERDICT_EXIT[result.verdict],
      verdictMeaning: EXIT_DESCRIPTION[VERDICT_EXIT[result.verdict]],
      scenarioId: result.scenarioId,
      seed: result.seed,
      ...(previousRunId !== undefined ? { previousRunId } : {}),
      ruleEvaluations: ruleSummary(result),
      // Same explanation the CLI prints (方案 §12 报错体验): the assistant does
      // not have to reverse-engineer the timeline to know WHY a run blocked.
      diagnostics: explainResult(result),
      runDir,
    },
  };
}

export async function toolRun(
  config: McpConfig,
  args: { scenarioPath?: unknown; seed?: unknown; fault?: unknown },
): Promise<ToolResult> {
  if (typeof args.scenarioPath !== "string" || args.scenarioPath === "") {
    throw new ToolError("rc_run requires string argument: scenarioPath");
  }
  if (args.seed !== undefined && (typeof args.seed !== "number" || !Number.isInteger(args.seed))) {
    throw new ToolError("rc_run argument seed must be an integer");
  }
  if (args.fault !== undefined && typeof args.fault !== "string") {
    throw new ToolError("rc_run argument fault must be a string");
  }
  const faultArgs: { fault?: string } = {};
  if (typeof args.fault === "string" && args.fault !== "") faultArgs.fault = args.fault;
  return runScenario(config, args.scenarioPath, args.seed, faultArgs.fault, undefined);
}

// -------------------------------------------------------------- rc_get_result

export async function toolGetResult(
  config: McpConfig,
  args: { runId?: unknown },
): Promise<ToolResult> {
  if (typeof args.runId !== "string" || args.runId === "") {
    throw new ToolError("rc_get_result requires string argument: runId");
  }
  assertSafeRunId(args.runId);
  const runDir = path.join(config.runsDir, args.runId);

  let result: RunResult;
  try {
    result = JSON.parse(await fsp.readFile(path.join(runDir, "result.json"), "utf8")) as RunResult;
  } catch {
    throw new ToolError(`run "${args.runId}" has no result.json under ${config.runsDir}`);
  }
  let events: TimelineEvent[];
  try {
    const text = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
    events = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      events.push(JSON.parse(line) as TimelineEvent);
    }
  } catch {
    throw new ToolError(`run "${args.runId}" has no readable events.jsonl under ${runDir}`);
  }
  return {
    payload: {
      runId: args.runId,
      verdict: result.verdict,
      exitCode: VERDICT_EXIT[result.verdict],
      result,
      events,
    },
  };
}

// ------------------------------------------------------------------ rc_rerun

async function readRunMeta(config: McpConfig, runId: string): Promise<McpRunMeta> {
  assertSafeRunId(runId);
  // Prefer our own sidecar; fall back to the CLI's cli.json so runs created
  // through the CLI entrance can be rerun through MCP (same config, same
  // result semantics — 方案 §7 三入口一致性).
  for (const file of [MCP_META_FILE, "cli.json"]) {
    let text: string;
    try {
      text = await fsp.readFile(path.join(config.runsDir, runId, file), "utf8");
    } catch {
      continue;
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ToolError(`${file} of run "${runId}" is not an object`);
    }
    const meta = value as { scenarioPath?: unknown; seed?: unknown; previousRunId?: unknown };
    if (typeof meta.scenarioPath !== "string" || typeof meta.seed !== "number") {
      throw new ToolError(`${file} of run "${runId}" lacks scenarioPath/seed`);
    }
    const out: McpRunMeta = { scenarioPath: meta.scenarioPath, seed: meta.seed };
    if (typeof meta.previousRunId === "string") out.previousRunId = meta.previousRunId;
    return out;
  }
  throw new ToolError(`run "${runId}" has no ${MCP_META_FILE} or cli.json under ${config.runsDir}`);
}

export async function toolRerun(
  config: McpConfig,
  args: { runId?: unknown },
): Promise<ToolResult> {
  if (typeof args.runId !== "string" || args.runId === "") {
    throw new ToolError("rc_rerun requires string argument: runId");
  }
  const meta = await readRunMeta(config, args.runId);
  // Same scenario, same seed (方案 §10 复跑: 重建初始状态，相同场景).
  return runScenario(config, meta.scenarioPath, meta.seed, undefined, args.runId);
}
