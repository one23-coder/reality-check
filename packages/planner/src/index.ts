// Bounded planner entry point (方案 §3.3 规则 9 / §10 模型边界).
export * from "./types.js";
export * from "./heuristic.js";
export * from "./model.js";

import { pickScenario } from "./heuristic.js";
import { planWithModel } from "./model.js";
import type { PlanDecision, PlanRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 512;

/**
 * Plan a run: keyword heuristic first; on needs-model, a bounded model call
 * (defaults 8000ms / 512 tokens).
 *
 * A scenario is returned ONLY when the heuristic matched a category clue or
 * the model selected a valid saved scenario id. When there is no category
 * clue and no usable model, the decision has needsModel=true and NO scenario
 * (`decision.scenario === undefined`) — the caller must not execute anything
 * (方案 §3.3 规则 9: 没有类别线索时返回 needsModel 而不是猜默认场景).
 *
 * This function never throws.
 */
export async function planScenario(
  req: PlanRequest,
  budget?: { timeoutMs?: number; maxTokens?: number },
): Promise<PlanDecision> {
  const timeoutMs = budget?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = budget?.maxTokens ?? DEFAULT_MAX_TOKENS;

  const decision = pickScenario(req);
  if (!decision.needsModel) return decision;

  return planWithModel(req, { timeoutMs, maxTokens });
}
