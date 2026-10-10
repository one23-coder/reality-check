// Bounded model planning (方案 §3.3 规则 9 / §10 模型边界): the model may only
// SELECT among saved scenarios. Model unavailable / timeout / budget exhausted
// / unknown scenario id / unparseable reply all fall back — to the
// keyword-matched saved scenario when there was a category clue, otherwise to
// a needs-model decision with NO scenario (guessing a default is forbidden).
// This module NEVER propagates exceptions upward.
import { parseJsonStrict } from "@rc/protocol";
import { pickScenario } from "./heuristic.js";
import type { PlanDecision, PlanRequest } from "./types.js";

type Params = Record<string, string | number | boolean>;

function sanitizeParams(value: unknown): Params {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Params = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string" || typeof val === "boolean") out[key] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
  }
  return out;
}

/** Model-planning failure fallback. If the keyword heuristic had matched a
 * saved scenario, fall back to it (模型不可用回退到已保存场景, 方案 §3.3 规则 9).
 * If there was NO category clue, NO scenario is chosen — guessing a default
 * is forbidden (规则 9: 没有类别线索时返回 needsModel 而不是猜默认场景). */
function modelFallback(req: PlanRequest, why: string): PlanDecision {
  const kw = pickScenario(req);
  if (!kw.needsModel && kw.scenario !== undefined) {
    return {
      scenario: kw.scenario,
      params: kw.params,
      fallback: "model-error",
      needsModel: false,
      reason: `${why}; fell back to keyword-matched saved scenario "${kw.scenario.id}"`,
    };
  }
  return {
    params: {},
    fallback: "needs-model",
    needsModel: true,
    reason: `${why}; no category clue, refusing to guess a default scenario`,
  };
}

function buildPrompt(req: PlanRequest): string {
  const ids = req.savedScenarios.length > 0 ? req.savedScenarios.map((s) => s.id).join(", ") : "(none)";
  return [
    "You are a bounded scenario planner. Choose exactly one saved scenario id.",
    `Saved scenario ids: ${ids}`,
    `User request: ${req.request}`,
    'Reply with JSON only: {"scenarioId": string, "params": object}',
  ].join("\n");
}

/**
 * Plan with the injected model client under a hard timeout / token budget.
 * Model unavailability, timeout, budget exhaustion and unknown scenario ids
 * all fall back per modelFallback — this function never throws.
 */
export async function planWithModel(
  req: PlanRequest,
  budget: { timeoutMs: number; maxTokens: number },
): Promise<PlanDecision> {
  const { timeoutMs, maxTokens } = budget;

  if (!req.model) {
    return modelFallback(req, "model unavailable: no model client configured");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reply: string;
  try {
    reply = await Promise.race([
      req.model.complete(buildPrompt(req), { timeoutMs, maxTokens }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`model call timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Budget exhaustion is bounded by the same wall clock as the call.
    const why = message.includes("timed out")
      ? `model call timed out after ${timeoutMs}ms (budget exhausted)`
      : `model call failed: ${message}`;
    return modelFallback(req, why);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (reply.trim() === "") {
    return modelFallback(req, "model returned empty reply (budget exhausted or model refused)");
  }

  let parsed: unknown;
  try {
    parsed = parseJsonStrict(reply, "model reply");
  } catch (e) {
    return modelFallback(req, `model reply is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return modelFallback(req, "model reply JSON is not an object");
  }
  const scenarioId = (parsed as { scenarioId?: unknown }).scenarioId;
  if (typeof scenarioId !== "string") {
    return modelFallback(req, 'model reply JSON missing string field "scenarioId"');
  }
  const scenario = req.savedScenarios.find((s) => s.id === scenarioId);
  if (!scenario) {
    return modelFallback(req, `model returned unknown scenario id "${scenarioId}"`);
  }
  return {
    scenario,
    params: sanitizeParams((parsed as { params?: unknown }).params),
    fallback: "heuristic",
    needsModel: false,
    reason: `bounded model selected saved scenario "${scenario.id}"`,
  };
}
