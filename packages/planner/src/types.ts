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
  /** Undefined on needs-model decisions: no clue and no usable model means NO scenario is chosen (方案 §3.3 规则 9). */
  scenario?: Scenario;
  params: Record<string, string | number | boolean>;
  fallback: PlannerFallback;
  needsModel: boolean;
  reason: string;
}
