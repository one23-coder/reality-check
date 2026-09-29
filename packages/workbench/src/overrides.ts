/** Parameterization overrides (方案 §6: 修改人数、角色、顺序等参数重新演练).
 *
 * Overrides are applied to a DEEP CLONE of the loaded scenario BEFORE
 * validateScenario() — a rejected override surfaces the validator's error
 * verbatim so the caller can fix it. The kernel is never fed an unvalidated
 * scenario.
 */
import { validateScenario, type Scenario, type Step } from "@rc/protocol";

export interface RunOverrides {
  /** Per-role attribute merge, keyed by role id (角色参数化). */
  roleAttrs?: Record<string, Record<string, string | number | boolean>>;
  /** Extra steps appended after the scenario's existing steps (顺序参数化).
   * Shape-checked by validateScenario like any other step. */
  stepsAppend?: Step[];
  /** Replacement scenario seed. */
  seed?: number;
}

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

/** Apply overrides to a deep clone and re-validate. Throws OverrideError for
 * structurally impossible overrides (unknown role id) and propagates the
 * validator's Error for schema violations; both map onto HTTP 400. */
export function applyOverrides(scenario: Scenario, overrides: RunOverrides | undefined): Scenario {
  const draft = structuredClone(scenario) as Scenario;
  if (overrides === undefined) return validateScenario(draft);

  if (overrides.roleAttrs !== undefined) {
    for (const [roleId, attrs] of Object.entries(overrides.roleAttrs)) {
      const role = draft.roles.find((r) => r.id === roleId);
      if (role === undefined)
        throw new OverrideError(`override roleAttrs: unknown role "${roleId}"`);
      role.attrs = { ...(role.attrs ?? {}), ...structuredClone(attrs) };
    }
  }
  if (overrides.stepsAppend !== undefined) {
    if (!Array.isArray(overrides.stepsAppend))
      throw new OverrideError("override stepsAppend: must be an array of steps");
    draft.steps.push(...structuredClone(overrides.stepsAppend));
  }
  if (overrides.seed !== undefined) {
    if (!Number.isInteger(overrides.seed) || overrides.seed < 0)
      throw new OverrideError(`override seed: must be a non-negative integer, got ${overrides.seed}`);
    draft.seed = overrides.seed;
  }
  return validateScenario(draft);
}

/** Prompt-injection guard for /api/draft (方案 §6: 注入式攻击用例必须被拒).
 * Natural language that asks for script execution or instruction overrides
 * never reaches the planner. */
const INJECTION_RE = /执行|运行.*脚本|execute.*script|ignore (previous|above) instructions/i;

export function looksLikeInjection(text: string): boolean {
  return INJECTION_RE.test(text);
}

/** Build a scenario DRAFT from a planner decision. Drafts are NEVER saved
 * into scenariosDir — they exist for review only (方案 §6: 模型生成物必须过
 * 结构校验+能力检查; 草案与可运行场景不可混淆). Returns the draft plus its
 * structural validation outcome. */
export function buildDraft(
  decision: { scenario: Scenario },
): { draft: Scenario; valid: true } | { draft: Scenario; valid: false; errors: string[] } {
  const draft = structuredClone(decision.scenario) as Scenario;
  // A placeholder decision ("__unresolved__") stays as-is so its validation
  // failures are visible; a real selection gets a distinct draft id.
  if (draft.id !== "__unresolved__") {
    draft.id = `${draft.id}-draft-${Date.now().toString(36)}`;
  }
  try {
    validateScenario(draft);
    return { draft, valid: true };
  } catch (e) {
    return { draft, valid: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
