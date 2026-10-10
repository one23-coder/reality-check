/** Result 1.0 validator tests — focused on the CLOSED keep-set of evidence-gap
 * names (方案 §10: 证据缺失必须按要求逐项列出；校验器拒收无法归类的字符串).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EVIDENCE_KINDS } from "../src/manifest.js";
import { MISSING_EVIDENCE_TYPES, resultV } from "../src/result.js";
import { VError } from "../src/v.js";
import type { MissingEvidenceType, RunResult } from "../src/result.js";

function resultWithGaps(gaps: string[]): RunResult {
  return {
    protocol: { result: "1.0" },
    runId: "rc-test",
    scenarioId: "s1",
    scenarioSha256: "deadbeef",
    seed: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    verdict: "inconclusive",
    ruleEvaluations: [
      {
        ruleId: "r1",
        assertionId: "a1",
        verdict: "inconclusive",
        observed: null,
        expected: "eq 2",
        evidenceRefs: [],
        missingEvidenceTypes: gaps as MissingEvidenceType[],
      },
    ],
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
  };
}

describe("result 1.0 missingEvidenceTypes", () => {
  it("accepts every declared gap name", () => {
    const parsed = resultV(resultWithGaps([...MISSING_EVIDENCE_TYPES]), "result");
    assert.deepEqual(parsed.ruleEvaluations[0]?.missingEvidenceTypes, [...MISSING_EVIDENCE_TYPES]);
  });

  it("covers every EvidenceKind (the two lists cannot drift apart)", () => {
    for (const kind of EVIDENCE_KINDS) {
      assert.ok(
        (MISSING_EVIDENCE_TYPES as readonly string[]).includes(kind),
        `MISSING_EVIDENCE_TYPES must include evidence kind "${kind}"`,
      );
    }
  });

  it("rejects an unclassifiable gap string (no placeholders pass validation)", () => {
    assert.throws(
      () => resultV(resultWithGaps(["mystery"]), "result"),
      (e: unknown) => {
        assert.ok(e instanceof VError);
        assert.match(e.message, /expected one of \[/);
        return true;
      },
    );
  });
});
