/** Assertion evaluation (方案 §10: 断言主体必须走场景声明的观察器 SQL).
 *
 * The kernel evaluates each assertion against rows produced by the observer
 * the assertion names — never an adapter-substituted "equivalent query"
 * (§3.3 规则 2: two readings would let the displayed value and the judged
 * value diverge). Evidence incompleteness downgrades the verdict to
 * inconclusive and names the missing evidence types (§10).
 */
import type { Assertion, EvidenceRef, RuleEvaluation, Verdict } from "@reality-check/protocol";
import { internalError } from "./errors.js";

export interface ObserverReading {
  observerId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** Evidence refs backing this reading (sql-dump file in the run dir). */
  evidence: EvidenceRef[];
}

type Cmp = (observed: number, expected: number) => boolean;

const CMP: Record<Assertion["op"], Cmp> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  countEq: (a, b) => a === b,
};

export function evaluateAssertion(
  assertion: Assertion,
  readings: Map<string, ObserverReading>,
): RuleEvaluation {
  const reading = readings.get(assertion.observer);
  if (reading === undefined || reading.rows.length === 0)
    return inconclusive(assertion, [], "observer produced no rows", ["sql-rows"]);
  const column = reading.columns[0];
  if (column === undefined)
    return inconclusive(assertion, reading.evidence, "observer declared no columns", ["columns"]);
  const first = reading.rows[0];
  if (first === undefined)
    return inconclusive(assertion, reading.evidence, "observer returned no rows", ["sql-rows"]);
  const cell = first[column];
  if (typeof cell !== "number")
    return inconclusive(
      assertion,
      reading.evidence,
      `column "${column}" is not numeric (got ${typeof cell})`,
      ["numeric-cell"],
    );
  const observed = assertion.op === "countEq" ? reading.rows.length : cell;
  const cmp = CMP[assertion.op];
  if (cmp === undefined) throw internalError(`unknown assertion op "${assertion.op}"`);
  const held = cmp(observed, assertion.value);
  return {
    ruleId: assertion.rule,
    assertionId: assertion.id,
    verdict: held ? "held" : "violated",
    observed,
    expected: `${assertion.op} ${assertion.value}`,
    evidenceRefs: reading.evidence,
  };
}

function inconclusive(
  assertion: Assertion,
  evidence: EvidenceRef[],
  reason: string,
  missing: string[],
): RuleEvaluation {
  return {
    ruleId: assertion.rule,
    assertionId: assertion.id,
    verdict: "inconclusive",
    observed: null,
    expected: `${assertion.op} ${assertion.value}`,
    evidenceRefs: evidence,
    missingEvidenceTypes: missing,
    reason,
  };
}

/** Roll rule evaluations up to a verdict (方案 §10 结果语义).
 * - any violated rule with complete evidence -> failed (exit 1);
 * - any inconclusive evaluation -> inconclusive (exit 2), naming gaps;
 * - otherwise passed (exit 0). blocked never comes from here. */
export function rollUpVerdict(evaluations: RuleEvaluation[]): Verdict {
  if (evaluations.length === 0)
    throw internalError("no rule evaluations; scenario must declare at least one assertion");
  const violated = evaluations.filter((e) => e.verdict === "violated");
  const inconclusive = evaluations.filter((e) => e.verdict === "inconclusive");
  if (violated.length > 0 && inconclusive.length === 0) return "failed";
  if (inconclusive.length > 0) return "inconclusive";
  return "passed";
}
