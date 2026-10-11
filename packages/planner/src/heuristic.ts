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
  // "last" 单独作关键词太危险（"last-minute cancellation" 会被判成争抢）；写成
  // 短语才表达"最后一个名额"的本意。
  { key: "contend", idToken: "contend", tokens: ["争抢", "抢", "contend", "race", "last slot", "last seat"] },
  { key: "cancel-waitlist", idToken: "cancel-waitlist", tokens: ["取消", "候补", "cancel", "waitlist"] },
  { key: "normal", idToken: "normal", tokens: ["报名", "book", "normal"] },
];

/** 关键词在文本中的位置；找不到返回 -1。
 *
 * **ASCII 关键词必须从词首开始**：`race` 不能命中 `trace`/`grace`，`book` 不能命中
 * `facebook`/`notebook`，`last` 不能命中 `blast`。裸 `indexOf` 的子串匹配会把这些噪声
 * 当成「有线索」，于是**高置信度地**选错场景（`needsModel:false` + `fallback:heuristic`），
 * 用户会在毫无提示的情况下拿到另一个场景的结论。
 *
 * 只要求**词首**而不要求词尾：这样 `cancel` 仍能命中 `cancellation`、`book` 仍能命中
 * `bookings`——搜索侧宁可保留词形变化，也不能把常见说法漏给"需要模型"。
 * 中文没有词边界，仍按子串匹配（`抢` 命中 `争抢` 是期望行为）。 */
function tokenIndex(haystack: string, token: string): number {
  if (/^[a-z0-9- ]+$/.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\b${escaped}`, "i").exec(haystack);
    return m?.index ?? -1;
  }
  return haystack.indexOf(token);
}

function pickCategory(text: string): Category | undefined {
  const lower = text.toLowerCase();
  let best: { cat: Category; idx: number } | undefined;
  for (const cat of CATEGORIES) {
    for (const token of cat.tokens) {
      const idx = tokenIndex(lower, token.toLowerCase());
      if (idx >= 0 && (best === undefined || idx < best.idx)) best = { cat, idx };
    }
  }
  return best?.cat;
}

/** 参数抽取的上下界：人数是"几个人"这种小数量，超出范围说明匹配到的是别的数字
 * （容量、金额、年份），宁可不给参数，也不把无关数字当人数。 */
const COUNT_MIN = 1;
const COUNT_MAX = 1000;

/** Extract explicit counts like "3人" / "3 people" / n=3 into params.count.
 *
 * 模式按**可靠性**排序：显式赋值 `n=` 优先于自然语句（`"10人会议室...n=3"` 想要的是
 * 3）。全角数字、中文间空白不做推断——宁可没有参数，也不猜。 */
function extractCount(text: string): number | undefined {
  // 数字两侧都要有边界：否则 `9999人` 会被 `\d{1,3}` 截成 999（一个"看起来合理"
  // 的人数），比不抽取更糟——它会把无关数字当成用户明确给出的人数。
  const patterns: readonly RegExp[] = [
    /(?<!\d)n\s*=\s*(\d{1,4})(?!\d)/i,
    /(?<!\d)(\d{1,3})(?!\d)\s*(?:人|位)/,
    /(?<!\d)(\d{1,3})(?!\d)\s*people\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] === undefined) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= COUNT_MIN && n <= COUNT_MAX) return n;
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
