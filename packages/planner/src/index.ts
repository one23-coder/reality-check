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
 * (defaults 8000ms / 512 tokens); if that cannot find anything, the first
 * saved scenario with fallback "saved-scenario".
 *
 * The ONLY throw in this package happens when savedScenarios is empty and no
 * usable decision exists at all: Error("no scenario available and model required").
 */
export async function planScenario(
  req: PlanRequest,
  budget?: { timeoutMs?: number; maxTokens?: number },
): Promise<PlanDecision> {
  const timeoutMs = budget?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = budget?.maxTokens ?? DEFAULT_MAX_TOKENS;

  const decision = pickScenario(req);
  if (!decision.needsModel) return decision;

  const modeled = await planWithModel(req, { timeoutMs, maxTokens });
  if (!modeled.needsModel) return modeled;

  const first = req.savedScenarios[0];
  if (first) {
    return {
      scenario: first,
      params: {},
      fallback: "saved-scenario",
      needsModel: false,
      reason: `model planning unavailable (${modeled.reason}); using first saved scenario "${first.id}"`,
    };
  }
  throw new Error("no scenario available and model required");
}
