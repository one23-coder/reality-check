/** Scenario 1.1 validator: conditional steps (when) and the version gate.
 * 1.0 documents stay valid, but may not use 1.1 features (fail closed). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateScenario } from "../src/scenario.js";
import { VError } from "../src/v.js";

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: { scenario: "1.1" },
    id: "s",
    name: "s",
    description: "d",
    app: "a",
    seed: 1,
    roles: [{ id: "alice", account: { username: "a", password: "p" }, seedRole: "none" }],
    steps: [{ id: "s1", actor: "alice", op: "navigate", params: { path: "/" } }],
    observers: [
      { id: "count", sql: "SELECT COUNT(*) AS n FROM t", tables: ["t"], expectColumns: ["n"] },
    ],
    assertions: [{ id: "a1", rule: "r1", observer: "count", op: "eq", value: 2 }],
    rules: [{ id: "r1", description: "r" }],
    ...over,
  };
}

function conditional(when: unknown, version = "1.1"): Record<string, unknown> {
  return doc({
    protocol: { scenario: version },
    steps: [
      { id: "s1", actor: "alice", op: "navigate", params: { path: "/" }, when },
    ],
  });
}

describe("scenario 1.1 conditional steps", () => {
  it("accepts a numeric condition on a declared observer", () => {
    const parsed = validateScenario(conditional({ observer: "count", op: "gte", value: 2 }));
    assert.deepEqual(parsed.steps[0]?.when, { observer: "count", op: "gte", value: 2 });
  });

  it("accepts an eqStr condition with expected and no value", () => {
    const parsed = validateScenario(conditional({ observer: "count", op: "eqStr", expected: "bob" }));
    assert.equal(parsed.steps[0]?.when?.expected, "bob");
  });

  it("rejects 1.0 documents that use when (fail closed, no half semantics)", () => {
    assert.throws(
      () => validateScenario(conditional({ observer: "count", op: "gte", value: 2 }, "1.0")),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /require scenario 1\.1/);
        return true;
      },
    );
  });

  it("rejects a condition on an observer that is not declared", () => {
    assert.throws(
      () => validateScenario(conditional({ observer: "ghost", op: "gte", value: 2 })),
      /unknown observer "ghost"/,
    );
  });

  it("enforces the same op/value/expected pairing as assertions", () => {
    assert.throws(
      () => validateScenario(conditional({ observer: "count", op: "eqStr" })),
      /requires "expected"/,
    );
    assert.throws(
      () => validateScenario(conditional({ observer: "count", op: "gte" })),
      /requires "value"/,
    );
    assert.throws(
      () => validateScenario(conditional({ observer: "count", op: "gte", value: 1, expected: "x" })),
      /only valid for op "eqStr"/,
    );
  });

  it("rejects a conditional barrier step (并发组没有逐步骤条件语义)", () => {
    assert.throws(
      () =>
        validateScenario(
          doc({
            steps: [
              { id: "b1", actor: "alice", op: "submit", barrier: true, when: { observer: "count", op: "gte", value: 1 } },
              { id: "b2", actor: "alice", op: "submit", barrier: true },
            ],
          }),
        ),
      /cannot be conditional/,
    );
  });

  it("still rejects an unsupported scenario version", () => {
    assert.throws(() => validateScenario(doc({ protocol: { scenario: "2.0" } })), VError);
  });
});
