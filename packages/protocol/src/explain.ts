/** 结果解释器（方案 §12 报错体验: 用不着翻源码就知道为什么）。
 *
 * 把 RunResult 变成「用户能直接行动」的几行字：blocked 发生在哪个阶段、原因是什么、
 * 哪些步骤没能执行；inconclusive 缺的是哪一类证据；以及（由调用方补上）产物在哪。
 * 这是纯函数、无 IO，CLI / MCP / 报告共用同一套解释，避免四处各写一遍措辞。
 */
import type { RunResult } from "./result.js";

/** Human-readable reasons to act on. Empty when the run needs no explanation
 * (passed / failed 的业务归因已经由 ruleEvaluations 给出). */
export function explainResult(result: RunResult): string[] {
  const lines: string[] = [];

  for (const event of result.timeline) {
    if (event.kind !== "blocked") continue;
    const stage = typeof event.detail["stage"] === "string" ? event.detail["stage"] : "unknown stage";
    const reason =
      typeof event.detail["error"] === "string"
        ? event.detail["error"]
        : typeof event.detail["reason"] === "string"
          ? event.detail["reason"]
          : "no reason recorded";
    lines.push(`blocked at ${stage}: ${reason}`);

    const steps = event.detail["steps"];
    if (Array.isArray(steps) && steps.length > 0) {
      const reasons = event.detail["reasons"];
      const detail =
        Array.isArray(reasons) && reasons.length > 0 ? ` (${reasons.map(String).join("; ")})` : "";
      lines.push(
        `步骤无法执行: ${steps.map(String).join(", ")}${detail} —— 环境/工具失败，不是业务结论`,
      );
    }
    if (stage === "claimDataRoot") {
      lines.push("（数据目录已有内容但没有本次运行的 ownership.json 标记，方案 §10 拒绝在该目录上运行）");
    }
    if (stage === "setupEnv") {
      lines.push("（应用没能起来：检查 app.entry 指向的入口、依赖是否安装、端口是否被占用）");
    }
  }

  for (const evaluation of result.ruleEvaluations) {
    if (evaluation.verdict !== "inconclusive") continue;
    const gaps = evaluation.missingEvidenceTypes ?? [];
    lines.push(
      `inconclusive ${evaluation.ruleId} (${evaluation.assertionId}): ` +
        `缺少 ${gaps.length > 0 ? gaps.join(", ") : "证据"}`,
    );
  }

  const retried = result.attempts.filter((a) => (a.attemptIndex ?? 1) > 1);
  if (retried.length > 0) {
    lines.push(
      `重试记录: ${retried.map((a) => `${a.stepId}#${String(a.attemptIndex)}`).join(", ")}（每次尝试都留在时间线里）`,
    );
  }

  return lines;
}

/** Steps that took the longest, for "哪一步慢" without reading logs. */
export function slowestSteps(result: RunResult, limit = 3): { stepId: string; durationMs: number }[] {
  return result.attempts
    .filter((a) => typeof a.durationMs === "number")
    .map((a) => ({ stepId: a.stepId, durationMs: a.durationMs as number }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
}
