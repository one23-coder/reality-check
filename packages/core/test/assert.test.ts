import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Assertion } from "@rc/protocol";
import { evaluateAssertion, rollUpVerdict } from "../src/assert.js";
import type { ObserverReading } from "../src/adapter.js";

function assertion(overrides: Partial<Assertion> = {}): Assertion {
  return {
    id: "a1",
    rule: "r1",
    observer: "o1",
    op: "eq",
    value: 5,
    ...overrides,
  };
}

function reading(overrides: Partial<ObserverReading> = {}): ObserverReading {
  return {
    observerId: "o1",
    columns: ["count"],
    rows: [{ count: 5 }],
    evidence: [],
    ...overrides,
  };
}

function single(a: Assertion, r: ObserverReading) {
  return evaluateAssertion(a, new Map([[r.observerId, r]]));
}

describe("evaluateAssertion", () => {
  it("eq: held and violated", () => {
    assert.equal(single(assertion({ op: "eq", value: 5 }), reading()).verdict, "held");
    assert.equal(single(assertion({ op: "eq", value: 6 }), reading()).verdict, "violated");
  });

  it("gt: held and violated", () => {
    assert.equal(single(assertion({ op: "gt", value: 4 }), reading()).verdict, "held");
    assert.equal(single(assertion({ op: "gt", value: 5 }), reading()).verdict, "violated");
  });

  it("lte: held and violated", () => {
    assert.equal(single(assertion({ op: "lte", value: 5 }), reading()).verdict, "held");
    assert.equal(single(assertion({ op: "lte", value: 4 }), reading()).verdict, "violated");
  });

  it("countEq compares the row count, not a cell", () => {
    const two = reading({ rows: [{ count: 1 }, { count: 1 }] });
    assert.equal(single(assertion({ op: "countEq", value: 2 }), two).verdict, "held");
    assert.equal(single(assertion({ op: "countEq", value: 3 }), two).verdict, "violated");
    const observed = single(assertion({ op: "countEq", value: 3 }), two).observed;
    assert.equal(observed, 2);
  });

  it("missing observer is inconclusive naming rows", () => {
    const e = evaluateAssertion(assertion(), new Map());
    assert.equal(e.verdict, "inconclusive");
    assert.deepEqual(e.missingEvidenceTypes, ["rows"]);
  });

  it("empty rows are inconclusive naming rows", () => {
    const e = single(assertion(), reading({ rows: [] }));
    assert.equal(e.verdict, "inconclusive");
    assert.deepEqual(e.missingEvidenceTypes, ["rows"]);
  });

  it("no columns is inconclusive naming columns", () => {
    const e = single(assertion(), reading({ columns: [] }));
    assert.equal(e.verdict, "inconclusive");
    assert.deepEqual(e.missingEvidenceTypes, ["columns"]);
  });

  it("non-numeric first cell is inconclusive naming numeric-cell", () => {
    const e = single(assertion(), reading({ rows: [{ count: "five" }] }));
    assert.equal(e.verdict, "inconclusive");
    assert.deepEqual(e.missingEvidenceTypes, ["numeric-cell"]);
  });

  it("carries the observer's evidence refs", () => {
    const refs = [
      { kind: "sql-dump" as const, file: "evidence/o1.sql", seq: 0, sha256: "abc" },
    ];
    const e = single(assertion(), reading({ evidence: refs }));
    assert.equal(e.evidenceRefs, refs);
    assert.equal(e.ruleId, "r1");
    assert.equal(e.assertionId, "a1");
    assert.equal(e.observed, 5);
    assert.equal(e.expected, "eq 5");
  });
});

describe("rollUpVerdict", () => {
  const held = { ruleId: "r", assertionId: "a", verdict: "held" as const, observed: 1, expected: "eq 1", evidenceRefs: [] };
  const violated = { ...held, verdict: "violated" as const };
  const inconclusive = { ...held, verdict: "inconclusive" as const, missingEvidenceTypes: ["sql-dump" as const] };

  it("throws internal error on empty evaluations", () => {
    assert.throws(() => rollUpVerdict([]), (e: unknown) => {
      assert.ok(e instanceof Error);
      return true;
    });
  });

  it("maps pure outcomes", () => {
    assert.equal(rollUpVerdict([held]), "passed");
    assert.equal(rollUpVerdict([held, held]), "passed");
    assert.equal(rollUpVerdict([violated]), "failed");
    assert.equal(rollUpVerdict([violated, violated]), "failed");
  });

  it("a proven violation is NOT downgraded by an unrelated observation gap", () => {
    // 旧行为「有 inconclusive 一律 inconclusive」会把一次真实超订（violated）因
    // 另一个观察器读空而报成 exit 2 —— 缺口仍在该条规则上具名，但不改结论。
    assert.equal(rollUpVerdict([violated, inconclusive]), "failed");
    assert.equal(rollUpVerdict([inconclusive, violated, held]), "failed");
  });

  it("inconclusive alone still downgrades (nothing was proven)", () => {
    assert.equal(rollUpVerdict([inconclusive]), "inconclusive");
    assert.equal(rollUpVerdict([held, inconclusive]), "inconclusive");
  });
});

/** eqStr carries `expected` and NO `value` (the validator forbids both). */
function eqStrAssertion(expected: string): Assertion {
  return { id: "a1", rule: "r1", observer: "o1", op: "eqStr", expected };
}

describe("expected rendering", () => {
  it("eqStr keeps its expected string when the rule is inconclusive", () => {
    // 旧实现共用 `${op} ${value}`，而 eqStr 没有 value → "eqStr undefined"，
    // 报告里最关键的一句恰好在最需要它时丢失。
    const e = single(eqStrAssertion("alice"), reading({ rows: [] }));
    assert.equal(e.verdict, "inconclusive");
    assert.equal(e.expected, "eqStr alice");
    assert.doesNotMatch(e.expected, /undefined/);
  });

  it("renders the same shape for held/violated and numeric ops", () => {
    assert.equal(single(eqStrAssertion("alice"), reading({ rows: [{ count: "alice" }] })).expected, "eqStr alice");
    assert.equal(single(assertion({ op: "eq", value: 5 }), reading()).expected, "eq 5");
    // 负值可表达（余额透支/库存缺口）后，渲染也必须正确
    assert.equal(single(assertion({ op: "eq", value: -1 }), reading({ rows: [{ count: -1 }] })).expected, "eq -1");
  });
});
