/** Result schema, version 1.0 (方案 §10 结果语义; §4 证据四条铁律). */
import {
  VError,
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
import { EVIDENCE_KINDS } from "./manifest.js";
import { RESULT_VERSION } from "./versions.js";

export type Verdict = "passed" | "failed" | "inconclusive" | "blocked";

/** status -> exit code (0/1/2/3). Exit 64/70 never come from a verdict. */
export const VERDICT_EXIT: Record<Verdict, 0 | 1 | 2 | 3> = {
  passed: 0,
  failed: 1,
  inconclusive: 2,
  blocked: 3,
};

/** File evidence kinds — derived from the manifest's EVIDENCE_KINDS so the two
 * lists cannot drift apart (result.ts is where the barrel re-exports the type
 * from; manifest.ts keeps the runtime list). */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceRef {
  kind: EvidenceKind;
  /** Path relative to the run directory; must exist when referenced. */
  file: string;
  seq: number;
  /** Actor-role perspective this evidence belongs to (角色视角). */
  actor?: string;
  sha256: string;
}

export interface TimelineEvent {
  seq: number;
  t: string;
  kind: string;
  actor?: string;
  detail: Record<string, unknown>;
  /** Causal edge: seq of the event that caused this one (方案 §10: seq 排序,
   * causationId 才是因果边). */
  causation?: number;
}

/** 缺失证据类型的封闭全集 (方案 §10: 证据不完整时按「要求的类型逐项」核对并具名).
 *
 * = 证据文件类型 (EVIDENCE_KINDS, 单一来源) ∪ 观察结果自身的缺口
 * (core/inconclusive: "rows"/"columns"/"numeric-cell"/"cell") ∪ 内核核对
 * 证据引用失败 ("evidence-file", engine.ts). 刻意做成封闭联合而不是
 * `string[]`: 结果校验器据此**拒收**无法归类的字符串，避免「随便填个占位值」
 * 通过校验 (铁律: 证据缺失必须可归因到具体类型). */
export const MISSING_EVIDENCE_TYPES = [
  ...EVIDENCE_KINDS,
  "rows",
  "columns",
  "numeric-cell",
  "cell",
  "evidence-file",
] as const;

export type MissingEvidenceType = (typeof MISSING_EVIDENCE_TYPES)[number];

export interface RuleEvaluation {
  ruleId: string;
  verdict: "held" | "violated" | "not-evaluated" | "inconclusive";
  assertionId: string;
  observed: unknown;
  expected: string;
  evidenceRefs: EvidenceRef[];
  /** Set only when verdict is inconclusive: which evidence types were missing. */
  missingEvidenceTypes?: MissingEvidenceType[];
}

export interface EnvSummary {
  appVersion: string;
  adapterVersion: string;
  baseUrl: string;
  dbPath?: string;
  seed: number;
  platform: string;
}

/** How a step ended. `rejected` / `no-nav` are the app's honest answers to a
 * step that DID execute (business information); `error` means the step could
 * not be executed at all (方案 §3.3 规则 17 ⇒ 内核判 blocked)；`skipped` means a
 * conditional step's condition did not hold, so the step was deliberately not
 * executed (场景 1.1, 规则 22) — it is neither a failure nor a success and must
 * stay visible in the record. */
export type AttemptOutcome = "completed" | "rejected" | "no-nav" | "error" | "skipped";

export interface Attempt {
  stepId: string;
  actor: string;
  op: string;
  outcome: AttemptOutcome;
  httpStatus?: number;
  detail?: Record<string, unknown>;
  /** Evidence the adapter captured for THIS step (截图/DOM 快照). The kernel
   * verifies every ref before it enters the result (方案 §10 证据: 采集即落盘 +
   * 内核登记核对); a step may legitimately carry none. */
  evidence?: EvidenceRef[];
  /** Wall-clock duration of this attempt, measured by the kernel. Answers
   * "哪一步慢/哪一步卡住" without reading logs (方案 §12 运行时可观测性). */
  durationMs?: number;
  /** 1-based index of this attempt when the step declares `retry` (方案 §12
   * 场景表达): 1 = first try. Absent when the step was not retried. */
  attemptIndex?: number;
}

export interface RunResult {
  protocol: { result: typeof RESULT_VERSION };
  runId: string;
  scenarioId: string;
  scenarioSha256: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  verdict: Verdict;
  ruleEvaluations: RuleEvaluation[];
  timeline: TimelineEvent[];
  attempts: Attempt[];
  env: EnvSummary;
  /** Every referenced evidence file must exist under the run dir. */
  evidence: EvidenceRef[];
}

const evidenceRefV = vObject<EvidenceRef>({
  required: {
    kind: vEnum<EvidenceKind>(["screenshot", "dom-snapshot", "har", "sql-dump", "page-text"]),
    file: vString,
    seq: vInt({ min: 0 }),
    sha256: vString,
  },
  optional: { actor: vString },
});

const vUnionV: V<string | number | boolean | null> = (value, path) => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  )
    return value;
  throw new VError(`${path}: expected string|number|boolean|null`);
};

const timelineEventV = vObject<TimelineEvent>({
  required: { seq: vInt({ min: 0 }), t: vString, kind: vString, detail: vRecord(vUnionV) },
  optional: { actor: vString, causation: vInt({ min: 0 }) },
});

const ruleEvalV = vObject<RuleEvaluation>({
  required: {
    ruleId: vString,
    verdict: vEnum<RuleEvaluation["verdict"]>(["held", "violated", "not-evaluated", "inconclusive"]),
    assertionId: vString,
    observed: vUnionV,
    expected: vString,
    evidenceRefs: vArray(evidenceRefV),
  },
  optional: {
    missingEvidenceTypes: vArray(vEnum<MissingEvidenceType>(MISSING_EVIDENCE_TYPES)),
  },
});

export const resultV: V<RunResult> = vObject<RunResult>({
  required: {
    protocol: vObject({ required: { result: vLiteral(RESULT_VERSION) } }),
    runId: vString,
    scenarioId: vString,
    scenarioSha256: vString,
    seed: vInt({ min: 0 }),
    startedAt: vString,
    finishedAt: vString,
    verdict: vEnum<Verdict>(["passed", "failed", "inconclusive", "blocked"]),
    ruleEvaluations: vArray(ruleEvalV),
    timeline: vArray(timelineEventV),
    attempts: vArray(
      vObject<Attempt>({
        required: {
          stepId: vString,
          actor: vString,
          op: vString,
          outcome: vEnum<Attempt["outcome"]>([
            "completed",
            "rejected",
            "no-nav",
            "error",
            "skipped",
          ]),
        },
        optional: {
          httpStatus: vInt({ min: 100, max: 599 }),
          detail: vRecord(vUnionV),
          evidence: vArray(evidenceRefV),
          durationMs: vInt({ min: 0 }),
          attemptIndex: vInt({ min: 1 }),
        },
      }),
    ),
    env: vObject<EnvSummary>({
      required: {
        appVersion: vString,
        adapterVersion: vString,
        baseUrl: vString,
        seed: vInt({ min: 0 }),
        platform: vString,
      },
      optional: { dbPath: vString },
    }),
    evidence: vArray(evidenceRefV),
  },
});
