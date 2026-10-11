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
  EvidenceRef,
  MissingEvidenceType,
  RuleEvaluation,
  Verdict,
} from "@rc/protocol";
import { internalError } from "./errors.js";
import type { ObserverReading } from "./adapter.js";

type Cmp = (observed: number, expected: number) => boolean;

const CMP: Record<Exclude<Assertion["op"], "eqStr">, Cmp> = {
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
  if (assertion.op === "eqStr") {
    // String equality (账号名等): the cell must equal `expected`. An absent
    // cell is an evidence gap, not a violation (方案 §10).
    if (assertion.expected === undefined)
      throw internalError(`eqStr assertion "${assertion.id}" missing "expected"`);
    if (cell === undefined || cell === null)
      return inconclusive(assertion, reading.evidence, ["cell"]);
    const observedStr = String(cell);
    const heldStr = observedStr === assertion.expected;
    return {
      ruleId: assertion.rule,
      assertionId: assertion.id,
      verdict: heldStr ? "held" : "violated",
      observed: observedStr,
      expected: expectedText(assertion),
      evidenceRefs: reading.evidence,
    };
  }
  if (typeof cell !== "number")
    return inconclusive(assertion, reading.evidence, ["numeric-cell"]);
  const observed = assertion.op === "countEq" ? reading.rows.length : cell;
  const cmp = CMP[assertion.op];
  if (cmp === undefined) throw internalError(`unknown assertion op "${assertion.op}"`);
  if (assertion.value === undefined)
    throw internalError(`numeric assertion "${assertion.id}" missing "value"`);
  const held = cmp(observed, assertion.value);
  return {
    ruleId: assertion.rule,
    assertionId: assertion.id,
    verdict: held ? "held" : "violated",
    observed,
    expected: expectedText(assertion),
    evidenceRefs: reading.evidence,
  };
}

/** Human-readable expectation, rendered the SAME way for every verdict.
 *
 * `eqStr` carries `expected`; every numeric op carries `value` (the scenario
 * validator forbids mixing them). Rendering must follow that split — a shared
 * `${op} ${value}` template turns an inconclusive eqStr into
 * "eqStr undefined", i.e. the single most useful fact in the report is lost
 * exactly when someone needs it. */
export function expectedText(assertion: Assertion): string {
  return assertion.op === "eqStr"
    ? `eqStr ${assertion.expected ?? "(missing)"}`
    : `${assertion.op} ${String(assertion.value ?? "(missing)")}`;
}

function inconclusive(
  assertion: Assertion,
  evidence: EvidenceRef[],
  missing: MissingEvidenceType[],
): RuleEvaluation {
  return {
    ruleId: assertion.rule,
    assertionId: assertion.id,
    verdict: "inconclusive",
    observed: null,
    expected: expectedText(assertion),
    evidenceRefs: evidence,
    missingEvidenceTypes: missing,
  };
}

/** Roll rule evaluations up to a verdict (方案 §10 结果语义).
 *
 * - **any violated rule -> failed (exit 1)。** A proven business violation is
 *   NOT downgraded by an unrelated observation gap: the gap stays named on its
 *   own rule (`missingEvidenceTypes`), but it cannot turn a proven failure into
 *   an "inconclusive". (The old rule — "any inconclusive wins" — reported a real
 *   overbooking as exit 2 whenever some other observer happened to read empty.)
 * - otherwise any inconclusive -> inconclusive (exit 2), naming gaps;
 * - otherwise passed (exit 0). blocked never comes from here. */
export function rollUpVerdict(evaluations: RuleEvaluation[]): Verdict {
  if (evaluations.length === 0)
    throw internalError("no rule evaluations; scenario must declare at least one assertion");
  if (evaluations.some((e) => e.verdict === "violated")) return "failed";
  if (evaluations.some((e) => e.verdict === "inconclusive")) return "inconclusive";
  return "passed";
}
