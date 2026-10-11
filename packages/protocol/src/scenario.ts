/** Scenario description schema, version 1.0 (方案 §3.1 六套版本化协议之一).
 *
 * A scenario declares: roles (accounts with explicit seedRole), a closed
 * vocabulary of steps, named observers (SQL via the adapter's declared
 * observation surface), and assertions bound to business rules.
 */
import type { AttemptOutcome } from "./result.js";
import {
  SCENARIO_VERSION,
  SUPPORTED_SCENARIO_VERSIONS,
  type ScenarioVersion,
} from "./versions.js";
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

export { SCENARIO_VERSION };

/** Closed step vocabulary. Adapters declare which ops they support. */
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
  /** Bounded retry (方案 §12 场景表达：循环重试). The step is executed again
   * ONLY while the previous attempt's outcome is in `on` (default ["error"]),
   * up to `attempts` executions in total (≤5 by validation). Every attempt is
   * recorded separately in the timeline/attempts, and the LAST attempt decides
   * the run's outcome — so a retry can never hide a business result, it can
   * only absorb an infrastructure flake that is visible in the record. */
  retry?: StepRetry;
  /** Conditional step (场景 1.1, 方案 §3.3 规则 22). When the condition does not
   * hold the step is NOT executed and is recorded as `skipped` — never as a
   * failure and never as a success. The condition must name a DECLARED observer
   * (单一口径 stays intact) and is evaluated with the same comparison
   * vocabulary as assertions. */
  when?: StepCondition;
}

export interface StepCondition {
  observer: string;
  op: AssertOp;
  /** Required for numeric ops (forbidden for eqStr). */
  value?: number;
  /** Required for op "eqStr" (forbidden otherwise). */
  expected?: string;
}

export interface StepRetry {
  attempts: number;
  /** Outcomes that trigger another attempt. Default ["error"]. */
  on?: AttemptOutcome[];
}

export const STEP_RETRY_MAX_ATTEMPTS = 5;

export interface Observer {
  id: string;
  sql: string;
  /** Tables the SQL touches; the adapter whitelist-checks against these. */
  tables: string[];
  /** Column names expected in result rows; used for per-type evidence checks. */
  expectColumns: string[];
}

/** Closed assertion vocabulary — also used by conditional steps (`when`), so a
 * condition can never express something an assertion cannot. */
export const ASSERT_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "countEq",
  /** String equality on the observer's first column (账号名等), compared to `expected`. */
  "eqStr",
] as const;

export type AssertOp = (typeof ASSERT_OPS)[number];

export interface Assertion {
  id: string;
  /** Business rule this assertion defends; must exist in `rules`. */
  rule: string;
  observer: string;
  op: AssertOp;
  /** Required for numeric ops (forbidden for eqStr): the comparison value. */
  value?: number;
  /** Required for op "eqStr" (forbidden otherwise): the expected string. */
  expected?: string;
}

export interface Rule {
  id: string;
  description: string;
}

export interface Scenario {
  protocol: { scenario: ScenarioVersion };
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

const whenV = vObject<StepCondition>({
  required: { observer: vString, op: vEnum<AssertOp>([...ASSERT_OPS]) },
  // 负值必须可表达：余额透支、库存缺口、配额为负都是合法业务量，把 min 设成 0
  // 会逼用户绕道（例如只能用 gte 反向兜），等于让断言说不出业务真相。
  optional: { value: vInt(), expected: vString },
});

const stepV = vObject<Step>({
  required: { id: idField, actor: vString, op: vEnum<StepOp>(STEP_OPS) },
  optional: {
    params: vRecord(vUnion),
    barrier: vBool,
    when: whenV,
    retry: vObject<StepRetry>({
      required: { attempts: vInt({ min: 1, max: STEP_RETRY_MAX_ATTEMPTS }) },
      optional: {
        on: vArray(
          vEnum<AttemptOutcome>(["completed", "rejected", "no-nav", "error"]),
          { min: 1 },
        ),
      },
    }),
  },
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
    op: vEnum<AssertOp>([...ASSERT_OPS]),
  },
  optional: {
    /** Required for numeric ops (forbidden for eqStr): the comparison value.
     * Negative values are legal — 余额透支 / 库存缺口 / 超订后 capacity-left = -1
     * are exactly the quantities a check exists to catch. `min: 0` used to
     * forbid them, forcing an indirect `gte 0` that says less. */
    value: vInt(),
    /** Required for op "eqStr" (forbidden otherwise): the expected string. */
    expected: vString,
  },
});

const ruleV = vObject<Rule>({
  required: { id: idField, description: vString },
});

export const scenarioV: V<Scenario> = (value, path) => {
  const s = vObject<Scenario>({
    required: {
      protocol: vObject({ required: { scenario: vEnum<ScenarioVersion>([...SUPPORTED_SCENARIO_VERSIONS]) } }),
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
    if (a.op === "eqStr") {
      if (a.expected === undefined)
        throw new Error(`assertions[${a.id}]: op "eqStr" requires "expected"`);
      if (a.value !== undefined)
        throw new Error(`assertions[${a.id}]: "value" is not valid for op "eqStr"`);
    } else {
      if (a.value === undefined)
        throw new Error(`assertions[${a.id}]: numeric op "${a.op}" requires "value"`);
      if (a.expected !== undefined)
        throw new Error(`assertions[${a.id}]: "expected" is only valid for op "eqStr"`);
    }
  }
  // 条件步骤（场景 1.1）：1.0 文档不得使用；条件只能引用已声明观察器；比较
  // 词汇与断言一致（eqStr 用 expected，其余用 value）；并发组不接受逐步骤条件。
  for (const step of s.steps) {
    const when = step.when;
    if (when === undefined) continue;
    if (s.protocol.scenario === "1.0")
      throw new Error(
        `steps[${step.id}].when: conditional steps require scenario 1.1 (this document declares 1.0)`,
      );
    if (step.barrier === true)
      throw new Error(`steps[${step.id}]: a barrier step cannot be conditional (并发组没有逐步骤条件的语义)`);
    if (!observerIds.has(when.observer))
      throw new Error(`steps[${step.id}].when.observer: unknown observer "${when.observer}"`);
    if (when.op === "eqStr") {
      if (when.expected === undefined)
        throw new Error(`steps[${step.id}].when: op "eqStr" requires "expected"`);
      if (when.value !== undefined)
        throw new Error(`steps[${step.id}].when: "value" is not valid for op "eqStr"`);
    } else {
      if (when.value === undefined)
        throw new Error(`steps[${step.id}].when: numeric op "${when.op}" requires "value"`);
      if (when.expected !== undefined)
        throw new Error(`steps[${step.id}].when: "expected" is only valid for op "eqStr"`);
    }
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
