/** 结果呈现（方案 §12 报错体验 + 运行时可观测性）。
 *
 * 三件事，CLI 的 run / rerun 共用：
 *   1. 结论行 + 每条规则的判定（保持既有格式，脚本依赖它）；
 *   2. **为什么**：blocked 的阶段/原因/失败步骤、inconclusive 缺哪类证据
 *      （来自 protocol 的 explainResult，CLI / MCP / 报告共用同一套措辞）；
 *   3. `--verbose` 时的每步耗时与最慢步骤，以及运行产物的绝对路径。
 */
import path from "node:path";
import { explainResult, slowestSteps, VERDICT_EXIT, type RunResult, type TimelineEvent } from "@rc/protocol";

/** One line for a live event stream (`--verbose`), or null for events a human
 * does not need to watch (run-started, verdict, …). */
export function streamEventLine(event: TimelineEvent): string | null {
  const d = event.detail;
  switch (event.kind) {
    case "step": {
      const error = typeof d["error"] === "string" ? ` <${d["error"].slice(0, 160)}>` : "";
      const retry = typeof d["attemptIndex"] === "number" ? ` (attempt ${String(d["attemptIndex"])})` : "";
      return `  step ${String(d["stepId"])} -> ${String(d["outcome"])} ${String(d["durationMs"] ?? "?")}ms${retry}${error}`;
    }
    case "step-retry":
      return `  retry ${String(d["stepId"])}#${String(d["attemptIndex"])} (${String(d["reason"]).slice(0, 160)})`;
    case "observe":
      return `  observe ${String(d["observerId"])} rows=${String(d["rows"])}`;
    case "evidence-invalid":
      return `  ! evidence rejected: ${String(d["file"])} (${String(d["reason"])})`;
    case "blocked":
      return `  BLOCKED at ${String(d["stage"])}: ${String(d["error"] ?? d["reasons"] ?? "")}`;
    default:
      return null;
  }
}

export function verdictLines(
  result: RunResult,
  opts: { runDir?: string; verbose?: boolean } = {},
): string[] {
  const exit = VERDICT_EXIT[result.verdict];
  const lines = [`run ${result.runId}: ${result.verdict} (exit ${exit})`];
  for (const ev of result.ruleEvaluations) lines.push(`${ev.verdict} ${ev.ruleId}`);

  const diagnosis = explainResult(result);
  if (diagnosis.length > 0) {
    lines.push("--");
    lines.push(...diagnosis);
  }

  if (opts.verbose === true) {
    lines.push(`steps (${result.attempts.length}):`);
    for (const a of result.attempts) {
      const ms = a.durationMs !== undefined ? `${a.durationMs}ms` : "?ms";
      const attempt = a.attemptIndex !== undefined ? ` (attempt ${a.attemptIndex})` : "";
      lines.push(`  ${a.stepId} ${a.outcome} ${ms}${attempt}`);
    }
    const slow = slowestSteps(result, 3);
    if (slow.length > 0)
      lines.push(`slowest: ${slow.map((s) => `${s.stepId} ${s.durationMs}ms`).join(", ")}`);
  }

  if (opts.runDir !== undefined && result.verdict !== "passed" && result.verdict !== "failed") {
    lines.push(`full record: ${path.join(opts.runDir, "result.json")}`);
    lines.push(`report: ${path.join(opts.runDir, "report.html")}`);
  }
  return lines;
}
