// JSON report (方案 §10 结果语义): stable top-level key order so reports diff
// cleanly across runs; events are appended after the fixed result fields.
import type { RunResult, TimelineEvent } from "@rc/protocol";

export function renderJsonReport(result: RunResult, events: TimelineEvent[]): string {
  const ordered = {
    protocol: result.protocol,
    runId: result.runId,
    scenarioId: result.scenarioId,
    scenarioSha256: result.scenarioSha256,
    seed: result.seed,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    verdict: result.verdict,
    ruleEvaluations: result.ruleEvaluations,
    timeline: result.timeline,
    attempts: result.attempts,
    env: result.env,
    evidence: result.evidence,
  };
  const payload = { ...ordered, events };
  return JSON.stringify(payload, null, 2);
}
