/** Scenario description schema, version 1.0 (方案 §3.1 六套版本化协议之一).
 *
 * A scenario declares: roles (accounts with explicit seedRole), a closed
 * vocabulary of steps, named observers (SQL via the adapter's declared
 * observation surface), and assertions bound to business rules.
 */
import {
  vArray,
  vBool,
  vEnum,
  vInt,
  vLiteral,
  vObject,
  vRecord,
  vString,
  type V,
} from "./v.js";

export const SCENARIO_VERSION = "1.0";

/** Closed step vocabulary for scenario 1.0. Adapters declare which ops they support. */
export const STEP_OPS = [
  "navigate",
  "register",
  "login",
  "fill",
  "click",
  "submit",
  "wait",
  "barrier",
] as const;
export type StepOp = (typeof STEP_OPS)[number];

/** seedRole: whether the role *occupies* an initial slot (工程方案 §3.3 规则 7). */
export type SeedRole = "holder" | "none" | "waitlisted";

export interface Role {
  id: string;
  account: { username: string; password: string };
  seedRole: SeedRole;
  attrs?: Record<string, string | number | boolean>;
}

export interface Step {
  id: string;
  actor: string;
  op: StepOp;
  params?: Record<string, string | number | boolean>;
  /** When true this step joins the nearest preceding barrier group and is
   * submitted concurrently with its group peers (争抢场景同步屏障). */
  barrier?: boolean;
}

export interface Observer {
  id: string;
  sql: string;
  /** Tables the SQL touches; the adapter whitelist-checks against these. */
  tables: string[];
  /** Column names expected in result rows; used for per-type evidence checks. */
  expectColumns: string[];
}

export type AssertOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "countEq";

export interface Assertion {
  id: string;
  /** Business rule this assertion defends; must exist in `rules`. */
  rule: string;
  observer: string;
  op: AssertOp;
  /** For countEq: expected row count. Others: compare first row's first column. */
  value: number;
}

export interface Rule {
  id: string;
  description: string;
}

export interface Scenario {
  protocol: { scenario: typeof SCENARIO_VERSION };
  id: string;
  name: string;
  description: string;
  app: string;
  roles: Role[];
  steps: Step[];
  observers: Observer[];
  assertions: Assertion[];
  rules: Rule[];
  seed: number;
}

const idField = vString;

const roleV = vObject<Role>({
  required: {
    id: idField,
    account: vObject<Role["account"]>({
      required: { username: vString, password: vString },
    }),
    seedRole: vEnum<SeedRole>(["holder", "none", "waitlisted"]),
  },
  optional: { attrs: vRecord(vUnion) },
});

function vUnion(value: unknown, path: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  throw new Error(`${path}: expected string|number|boolean`);
}

const stepV = vObject<Step>({
  required: { id: idField, actor: vString, op: vEnum<StepOp>(STEP_OPS) },
  optional: { params: vRecord(vUnion), barrier: vBool },
});

const observerV = vObject<Observer>({
  required: {
    id: idField,
    sql: vString,
    tables: vArray(vString, { min: 1 }),
    expectColumns: vArray(vString, { min: 1 }),
  },
});

const assertionV = vObject<Assertion>({
  required: {
    id: idField,
    rule: vString,
    observer: vString,
    op: vEnum<AssertOp>(["eq", "ne", "gt", "gte", "lt", "lte", "countEq"]),
    value: vInt({ min: 0 }),
  },
});

const ruleV = vObject<Rule>({
  required: { id: idField, description: vString },
});

export const scenarioV: V<Scenario> = (value, path) => {
  const s = vObject<Scenario>({
    required: {
      protocol: vObject({ required: { scenario: vLiteral(SCENARIO_VERSION) } }),
      id: idField,
      name: vString,
      description: vString,
      app: vString,
      roles: vArray(roleV, { min: 1 }),
      steps: vArray(stepV, { min: 1 }),
      observers: vArray(observerV, { min: 1 }),
      assertions: vArray(assertionV, { min: 1 }),
      rules: vArray(ruleV, { min: 1 }),
      seed: vInt({ min: 0 }),
    },
  })(value, path);

  // Cross-references: every actor/observer/rule reference must resolve.
  const roleIds = new Set(s.roles.map((r) => r.id));
  const observerIds = new Set(s.observers.map((o) => o.id));
  const ruleIds = new Set(s.rules.map((r) => r.id));
  for (const step of s.steps) {
    if (!roleIds.has(step.actor))
      throw new Error(`steps[${step.id}].actor: unknown role "${step.actor}"`);
  }
  for (const a of s.assertions) {
    if (!observerIds.has(a.observer))
      throw new Error(`assertions[${a.id}].observer: unknown observer "${a.observer}"`);
    if (!ruleIds.has(a.rule)) throw new Error(`assertions[${a.id}].rule: unknown rule "${a.rule}"`);
  }
  // Barriers: a barrier step must be followed by >=1 more barrier step in the
  // same group; a lone barrier step is a config error (同步屏障无意义).
  for (let i = 0; i < s.steps.length; i++) {
    if (s.steps[i]?.barrier && s.steps[i + 1]?.barrier !== true && s.steps[i - 1]?.barrier !== true)
      throw new Error(`steps[${s.steps[i]?.id}]: barrier step must be grouped with others`);
  }
  // Duplicate ids across steps/observers/assertions.
  const ids = new Set<string>();
  const push = (prefix: string, arr: { id: string }[]) => {
    for (const el of arr) {
      const k = `${prefix}:${el.id}`;
      if (ids.has(k)) throw new Error(`${prefix} id duplicate: "${el.id}"`);
      ids.add(k);
    }
  };
  push("step", s.steps);
  push("observer", s.observers);
  push("assertion", s.assertions);
  push("rule", s.rules);
  return s;
};

export function validateScenario(value: unknown): Scenario {
  return scenarioV(value, "scenario");
}
