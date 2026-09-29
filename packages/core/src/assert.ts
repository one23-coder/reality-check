/** Assertion evaluation (方案 §10: 断言主体必须走场景声明的观察器 SQL).
 *
 * The kernel evaluates each assertion against rows produced by the observer
 * the assertion names — never an adapter-substituted "equivalent query"
 * (§3.3 规则 2: two readings would let the displayed value and the judged
 * value diverge). Evidence incompleteness downgrades the verdict to
 * inconclusive and names the missing evidence types (§10). Business outcomes
 * are never exceptions: an unreadable observation is "inconclusive".
 */
import type {
  Assertion,
  EvidenceKind,
  EvidenceRef,
  RuleEvaluation,
  Verdict,
} from "@rc/protocol";
import { internalError } from "./errors.js";
import type { ObserverReading } from "./adapter.js";

// The protocol types missingEvidenceTypes as EvidenceKind[] (file kinds), but
// the schema validator accepts any string: observation gaps ("rows",
// "columns", "numeric-cell") are evidence-type gaps of the reading itself.
export type MissingEvidence = EvidenceKind | "rows" | "columns" | "numeric-cell";

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
  if (reading === undefined)
    return inconclusive(assertion, [], ["rows"]);
  if (reading.rows.length === 0)
    return inconclusive(assertion, reading.evidence, ["rows"]);
  const column = reading.columns[0];
  if (column === undefined)
    return inconclusive(assertion, reading.evidence, ["columns"]);
  const first = reading.rows[0];
  if (first === undefined)
    return inconclusive(assertion, reading.evidence, ["rows"]);
  const cell = first[column];
  if (typeof cell !== "number")
    return inconclusive(assertion, reading.evidence, ["numeric-cell"]);
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
  missing: MissingEvidence[],
): RuleEvaluation {
  return {
    ruleId: assertion.rule,
    assertionId: assertion.id,
    verdict: "inconclusive",
    observed: null,
    expected: `${assertion.op} ${assertion.value}`,
    evidenceRefs: evidence,
    missingEvidenceTypes: missing as EvidenceKind[],
  };
}

/** Roll rule evaluations up to a verdict (方案 §10 结果语义).
 * - any violated rule with zero inconclusive evaluations -> failed (exit 1);
 * - any inconclusive evaluation -> inconclusive (exit 2), naming gaps;
 * - otherwise passed (exit 0). blocked never comes from here. */
export function rollUpVerdict(evaluations: RuleEvaluation[]): Verdict {
  if (evaluations.length === 0)
    throw internalError("no rule evaluations; scenario must declare at least one assertion");
  const violated = evaluations.filter((e) => e.verdict === "violated");
  const inconclusiveCount = evaluations.filter((e) => e.verdict === "inconclusive").length;
  if (violated.length > 0 && inconclusiveCount === 0) return "failed";
  if (inconclusiveCount > 0) return "inconclusive";
  return "passed";
}
