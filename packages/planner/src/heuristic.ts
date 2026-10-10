// Keyword heuristic over the natural-language request (方案 §3.3 规则 9:
import type { Scenario } from "@rc/protocol";
import type { PlanDecision, PlanRequest, PlannerFallback } from "./types.js";

interface Category {
  key: string;
  /** Token a saved scenario id must contain for this category. */
  idToken: string;
  /** Trigger keywords, Chinese and English, matched case-insensitively. */
  tokens: string[];
}

const CATEGORIES: readonly Category[] = [
  { key: "contend", idToken: "contend", tokens: ["争抢", "抢", "contend", "race", "last"] },
  { key: "cancel-waitlist", idToken: "cancel-waitlist", tokens: ["取消", "候补", "cancel", "waitlist"] },
  { key: "normal", idToken: "normal", tokens: ["报名", "book", "normal"] },
];

function pickCategory(text: string): Category | undefined {
  const lower = text.toLowerCase();
  let best: { cat: Category; idx: number } | undefined;
  for (const cat of CATEGORIES) {
    for (const token of cat.tokens) {
      const idx = lower.indexOf(token.toLowerCase());
      if (idx >= 0 && (best === undefined || idx < best.idx)) best = { cat, idx };
    }
  }
  return best?.cat;
}

/** Extract explicit counts like "3人" / "3 people" / n=3 into params.count. */
function extractCount(text: string): number | undefined {
  const patterns: readonly RegExp[] = [/(\d+)\s*人/, /(\d+)\s*people/i, /\bn\s*=\s*(\d+)/i];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1] !== undefined) return Number(m[1]);
  }
  return undefined;
}

function decision(
  scenario: Scenario,
  params: Record<string, string | number | boolean>,
  fallback: PlannerFallback,
  needsModel: boolean,
  reason: string,
): PlanDecision {
  return { scenario, params, fallback, needsModel, reason };
}

/** Needs-model decision: NO scenario is chosen — a missing clue must never
 * masquerade as a guessed default (方案 §3.3 规则 9). */
function decisionNoScenario(
  fallback: PlannerFallback,
  needsModel: boolean,
  reason: string,
): PlanDecision {
  return { params: {}, fallback, needsModel, reason };
}

/**
 * Keyword-only decision. Returns a needs-model decision (never a guessed
 * default scenario) when there is no category clue, or when the clue matches
 * but no saved scenario id contains the category token.
 */
export function pickScenario(req: PlanRequest): PlanDecision {
  const category = pickCategory(req.request);
  if (!category) {
    return decisionNoScenario(
      "needs-model",
      true,
      "no category clue in request; needs model to choose a scenario (no default is guessed)",
    );
  }
  const idToken = category.idToken.toLowerCase();
  const match = req.savedScenarios.find((s) => s.id.toLowerCase().includes(idToken));
  if (!match) {
    return decisionNoScenario(
      "needs-model",
      true,
      `category clue "${category.key}" matched but no saved scenario id contains "${category.idToken}"`,
    );
  }
  const count = extractCount(req.request);
  return decision(
    match,
    count !== undefined ? { count } : {},
    "heuristic",
    false,
    `keyword category "${category.key}" -> saved scenario "${match.id}"`,
  );
}
