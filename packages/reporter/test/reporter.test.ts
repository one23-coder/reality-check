import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderJsonReport } from "../src/json.js";
import { renderHtmlReport } from "../src/html.js";
import { VERDICT_EXIT, type RunResult, type Verdict } from "@rc/protocol";

const RUN_ID = "run-20260929-001";
const PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT = '<script>alert("xss")</script>';

function mkResult(verdict: Verdict): RunResult {
  return {
    protocol: { result: "1.0" },
    runId: RUN_ID,
    scenarioId: "booking-contend",
    scenarioSha256: "a".repeat(64),
    seed: 42,
    startedAt: "2026-09-29T10:00:00.000Z",
    finishedAt: "2026-09-29T10:00:05.000Z",
    verdict,
    ruleEvaluations: [
      {
        ruleId: "no-oversell",
        verdict: "held",
        assertionId: "assert-1",
        observed: 1,
        expected: "countEq 1",
        evidenceRefs: [
          { kind: "screenshot", file: "evidence/shot-1.png", seq: 1, sha256: "b".repeat(64) },
        ],
      },
      {
        ruleId: "no-oversell-waitlist",
        verdict: "inconclusive",
        assertionId: "assert-2",
        observed: null,
        expected: "countEq 0",
        evidenceRefs: [],
        missingEvidenceTypes: ["dom-snapshot"],
      },
    ],
    timeline: [
      { seq: 1, t: "2026-09-29T10:00:01.000Z", kind: "step-start", actor: "alice", detail: { op: "fill" } },
      {
        seq: 2,
        t: "2026-09-29T10:00:02.000Z",
        kind: "step-end",
        actor: "alice",
        detail: { note: SCRIPT },
        causation: 1,
      },
    ],
    attempts: [
      {
        stepId: "s1",
        actor: "alice",
        op: "click",
        outcome: "completed",
        httpStatus: 200,
        detail: { payload: PAYLOAD },
      },
    ],
    env: {
      appVersion: "1.2.3",
      adapterVersion: "0.1.0",
      baseUrl: "http://127.0.0.1:3000",
      seed: 42,
      platform: "win32",
    },
    evidence: [
      { kind: "screenshot", file: "evidence/shot-1.png", seq: 1, sha256: "b".repeat(64) },
    ],
  };
}

const EVENTS = mkResult("passed").timeline;

describe("renderJsonReport", () => {
  it("round-trips and preserves the verdict", () => {
    const result = mkResult("failed");
    const parsed = JSON.parse(renderJsonReport(result, EVENTS)) as RunResult & { events: unknown[] };
    assert.equal(parsed.verdict, "failed");
    assert.equal(parsed.runId, RUN_ID);
    assert.equal(parsed.protocol.result, "1.0");
    assert.equal(parsed.events.length, EVENTS.length);
    assert.deepEqual(parsed.ruleEvaluations, result.ruleEvaluations);
    assert.deepEqual(parsed.env, result.env);
  });

  it("uses the stable top-level key order ending with events", () => {
    const parsed = JSON.parse(renderJsonReport(mkResult("passed"), EVENTS)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [
      "protocol",
      "runId",
      "scenarioId",
      "scenarioSha256",
      "seed",
      "startedAt",
      "finishedAt",
      "verdict",
      "ruleEvaluations",
      "timeline",
      "attempts",
      "env",
      "evidence",
      "events",
    ]);
  });

  it("pretty-prints with 2-space indentation", () => {
    const json = renderJsonReport(mkResult("passed"), []);
    assert.match(json, /^ \{|\n {2}"/);
    assert.ok(json.includes('\n  "verdict"'));
  });
});

describe("renderHtmlReport", () => {
  const VERDICTS: readonly Verdict[] = ["passed", "failed", "inconclusive", "blocked"];

  for (const v of VERDICTS) {
    it(`renders a badge matching the JSON verdict for ${v}`, () => {
      const html = renderHtmlReport(mkResult(v), EVENTS);
      assert.ok(html.includes(`badge-${v}`), `missing badge class for ${v}`);
      assert.ok(html.includes(`${v} (exit ${VERDICT_EXIT[v]})`), `missing badge exit code for ${v}`);
    });
  }

  it("contains the rerun entry with the run id", () => {
    const html = renderHtmlReport(mkResult("passed"), EVENTS);
    assert.ok(html.includes(`npx reality-check rerun --run-id ${RUN_ID}`));
    assert.ok(html.includes("复跑入口"));
  });

  it("renders all Chinese section titles", () => {
    const html = renderHtmlReport(mkResult("passed"), EVENTS);
    for (const title of ["业务规则", "实验条件", "操作与请求时间线", "证据", "复跑入口"]) {
      assert.ok(html.includes(title), `missing section ${title}`);
    }
  });

  it("escapes injected HTML in dynamic values", () => {
    const html = renderHtmlReport(mkResult("passed"), EVENTS);
    assert.ok(!html.includes("<script>"), "raw <script> leaked into output");
    assert.ok(!html.includes(PAYLOAD), "raw payload leaked into output");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });

  it("renders timeline causation as an arrow to the causing seq", () => {
    const html = renderHtmlReport(mkResult("passed"), EVENTS);
    assert.ok(html.includes("&#8592; seq 1"));
  });

  it("lists evidence file paths in the business rules section", () => {
    const html = renderHtmlReport(mkResult("passed"), EVENTS);
    assert.ok(html.includes("evidence/shot-1.png"));
  });
});
