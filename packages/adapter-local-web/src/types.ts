/** Local, structurally-identical copies of the kernel-facing protocol types.
 *
 * Defined here on purpose (方案 §3.3 规则 2's spirit: single source of truth is
 * @rc/protocol — these shapes mirror it exactly so this adapter never blocks
 * on a sibling package mid-refactor). If protocol changes shape, keep these in
 * sync or switch to `import type { ... } from "@rc/protocol"`.
 */

export type SeedRole = "holder" | "none" | "waitlisted";

export interface Role {
  id: string;
  account: { username: string; password: string };
  seedRole: SeedRole;
  attrs?: Record<string, string | number | boolean>;
}

export type StepOp =
  | "navigate"
  | "register"
  | "login"
  | "fill"
  | "click"
  | "submit"
  | "wait"
  | "barrier";

export interface Step {
  id: string;
  actor: string;
  op: StepOp;
  params?: Record<string, string | number | boolean>;
  barrier?: boolean;
}

export type EvidenceKind = "screenshot" | "dom-snapshot" | "har" | "sql-dump" | "page-text";

export interface EvidenceRef {
  kind: EvidenceKind;
  /** Path relative to the run directory; must exist when referenced. */
  file: string;
  seq: number;
  actor?: string;
  sha256: string;
}

export interface EnvSummary {
  appVersion: string;
  adapterVersion: string;
  baseUrl: string;
  dbPath?: string;
  seed: number;
  platform: string;
}

export type AttemptOutcome = "completed" | "rejected" | "no-nav" | "error";

export interface Attempt {
  stepId: string;
  actor: string;
  op: string;
  outcome: AttemptOutcome;
  httpStatus?: number;
  detail?: Record<string, unknown>;
  /** Mirrors protocol `Attempt.evidence` (结果协议 1.0): the kernel verifies
   * and registers these refs — keep this mirror in sync with the protocol. */
  evidence?: EvidenceRef[];
}

export interface StepContext {
  runDir: string;
  seed: number;
  event(
    kind: string,
    detail: Record<string, unknown>,
    actor?: string,
    causation?: number,
  ): Promise<number>;
}

export interface ObserverReading {
  observerId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  evidence: EvidenceRef[];
}

export interface AdapterManifest {
  protocol: { manifest: "1.0" };
  adapterId: string;
  adapterVersion: string;
  scenarioVersion: string;
  supportedOps: string[];
  supportedAssertions: string[];
  observedTables: string[];
  evidenceKinds: EvidenceKind[];
  barriers: boolean;
  observers: Record<string, { sql: string; tables: string[]; columns: string[] }>;
}
