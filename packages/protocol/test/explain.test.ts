/** explainResult / slowestSteps — 报错具象化与可观测性的纯函数（方案 §12）。
 * CLI、MCP、报告共用同一套解释，因此措辞与取值只在这里定义一次。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainResult, slowestSteps } from "../src/explain.js";
import type { Attempt, RunResult, TimelineEvent } from "../src/result.js";

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    protocol: { result: "1.1" },
    runId: "rc-test",
    scenarioId: "s1",
    scenarioSha256: "deadbeef",
    seed: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    verdict: "blocked",
    ruleEvaluations: [],
    timeline: [],
    attempts: [],
    env: {
      appVersion: "1",
      adapterVersion: "1",
      baseUrl: "http://127.0.0.1:0",
      seed: 1,
      platform: "test",
    },
    evidence: [],
    ...over,
  };
}

function blockedEvent(detail: Record<string, unknown>): TimelineEvent {
  return { seq: 1, t: "2026-01-01T00:00:00.500Z", kind: "blocked", detail };
}

function attempt(over: Partial<Attempt>): Attempt {
  return { stepId: "s1", actor: "alice", op: "navigate", outcome: "completed", ...over };
}

describe("explainResult", () => {
  it("names the blocked stage and reason instead of making the user read source", () => {
    const lines = explainResult(
      result({
        timeline: [
          blockedEvent({
            stage: "claimDataRoot",
            error: 'data root "D:/x/data" already has content but no ownership marker; refusing to run (方案 §10)',
          }),
        ],
      }),
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^blocked at claimDataRoot: data root/);
    assert.match(lines[1] ?? "", /数据目录已有内容但没有本次运行的 ownership\.json 标记/);
  });

  it("explains a failed environment with actionable hints and the failing steps", () => {
    const lines = explainResult(
      result({
        timeline: [
          blockedEvent({ stage: "setupEnv", error: "app exited with code 1" }),
          blockedEvent({ stage: "steps", steps: ["cancel"], reasons: ["Chromium disconnected mid-run"] }),
        ],
      }),
    );
    assert.match(lines[0] ?? "", /blocked at setupEnv: app exited with code 1/);
    assert.match(lines[1] ?? "", /检查 app\.entry 指向的入口、依赖是否安装、端口是否被占用/);
    assert.match(lines[2] ?? "", /^blocked at steps: no reason recorded/);
    assert.match(lines[3] ?? "", /^步骤无法执行: cancel \(Chromium disconnected mid-run\)/);
    assert.match(lines[3] ?? "", /不是业务结论/);
  });

  it("lists the missing evidence types of every inconclusive rule", () => {
    const lines = explainResult(
      result({
        verdict: "inconclusive",
        ruleEvaluations: [
          {
            ruleId: "waitlist-declared-order",
            assertionId: "promotion",
            verdict: "inconclusive",
            observed: null,
            expected: "eqStr bob_rc",
            evidenceRefs: [],
            missingEvidenceTypes: ["rows", "evidence-file"],
          },
        ],
      }),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /inconclusive waitlist-declared-order \(promotion\): 缺少 rows, evidence-file/);
  });

  it("says nothing when the verdict speaks for itself", () => {
    assert.deepEqual(explainResult(result({ verdict: "failed" })), []);
  });

  it("surfaces retries so a recovered flake is never invisible", () => {
    const lines = explainResult(result({ attempts: [attempt({ attemptIndex: 2 })] }));
    assert.match(lines[0] ?? "", /重试记录: s1#2/);
  });
});

describe("slowestSteps", () => {
  it("ranks attempts by measured duration, ignoring unmeasured ones", () => {
    const slow = slowestSteps(
      result({
        attempts: [
          attempt({ stepId: "fast", durationMs: 10 }),
          attempt({ stepId: "unmeasured" }),
          attempt({ stepId: "slowest", durationMs: 900 }),
          attempt({ stepId: "middle", durationMs: 400 }),
        ],
      }),
      2,
    );
    assert.deepEqual(slow, [
      { stepId: "slowest", durationMs: 900 },
      { stepId: "middle", durationMs: 400 },
    ]);
  });
});
