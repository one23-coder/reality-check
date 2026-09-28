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
import { RESULT_VERSION } from "./versions.js";

export type Verdict = "passed" | "failed" | "inconclusive" | "blocked";

/** status -> exit code (0/1/2/3). Exit 64/70 never come from a verdict. */
export const VERDICT_EXIT: Record<Verdict, 0 | 1 | 2 | 3> = {
  passed: 0,
  failed: 1,
  inconclusive: 2,
  blocked: 3,
};

export type EvidenceKind = "screenshot" | "dom-snapshot" | "har" | "sql-dump" | "page-text";

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

export interface RuleEvaluation {
  ruleId: string;
  verdict: "held" | "violated" | "not-evaluated" | "inconclusive";
  assertionId: string;
  observed: unknown;
  expected: string;
  evidenceRefs: EvidenceRef[];
  /** Set only when verdict is inconclusive: which evidence types were missing. */
  missingEvidenceTypes?: EvidenceKind[];
}

export interface EnvSummary {
  appVersion: string;
  adapterVersion: string;
  baseUrl: string;
  dbPath?: string;
  seed: number;
  platform: string;
}

export interface Attempt {
  stepId: string;
  actor: string;
  op: string;
  outcome: "completed" | "rejected" | "no-nav" | "error";
  httpStatus?: number;
  detail?: Record<string, unknown>;
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
  optional: { missingEvidenceTypes: vArray(vString) },
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
          outcome: vEnum<Attempt["outcome"]>(["completed", "rejected", "no-nav", "error"]),
        },
        optional: { httpStatus: vInt({ min: 100, max: 599 }), detail: vRecord(vUnionV) },
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
