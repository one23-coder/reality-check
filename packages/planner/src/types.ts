// Planner public types (方案 §3.3 规则 9 / §10 模型边界).
import { SCENARIO_VERSION, type Scenario } from "@rc/protocol";

/** How the final decision was reached (受限规划器的四类回退). */
export type PlannerFallback = "saved-scenario" | "heuristic" | "needs-model" | "model-error";

/**
 * Bounded model client. Interface only — the planner never performs real LLM
 * calls and holds no API key; the host injects a client if one is available.
 */
export interface ModelClient {
  complete(prompt: string, opts: { timeoutMs: number; maxTokens: number }): Promise<string>;
}

export interface PlanRequest {
  request: string;
  savedScenarios: Scenario[];
  model?: ModelClient;
}

export interface PlanDecision {
  scenario: Scenario;
  params: Record<string, string | number | boolean>;
  fallback: PlannerFallback;
  needsModel: boolean;
  reason: string;
}

/**
 * Internal placeholder used when NO scenario could be selected at all (empty
 * savedScenarios). It is never executed: planScenario() throws
 * "no scenario available and model required" instead of returning a decision
 * that carries it. Needs-model decisions also carry it — a missing clue must
 * never masquerade as a guessed default scenario (方案 §3.3 规则 9).
 */
export const PLACEHOLDER_SCENARIO: Scenario = {
  protocol: { scenario: SCENARIO_VERSION },
  id: "__unresolved__",
  name: "__unresolved__",
  description: "placeholder: no scenario could be selected",
  app: "",
  roles: [],
  steps: [],
  observers: [],
  assertions: [],
  rules: [],
  seed: 0,
};
