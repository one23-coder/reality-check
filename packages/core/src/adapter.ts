/** Adapter interface, version 1.0 (方案 §3 六套协议之「适配接口 1.0」).
 *
 * The adapter owns the app-under-test lifecycle, executes scenario steps,
 * runs the scenario-declared observer SQL, and writes evidence into the run
 * directory. The kernel only ever talks to the app through this interface.
 */
import type {
  AdapterManifest,
  Attempt,
  EnvSummary,
  EvidenceKind,
  EvidenceRef,
  Role,
  Step,
} from "@rc/protocol";

/** A single observation: rows read via the scenario-declared observer SQL,
 * with evidence refs backing the reading (sql-dump in the run dir). */
export interface ObserverReading {
  observerId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  evidence: EvidenceRef[];
}

/** Execution context handed to the adapter for each step. `event` appends to
 * the run timeline and resolves to the assigned seq (usable as a causation
 * edge for later events). */
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

export interface LocalWebAdapterV1 {
  manifest(): AdapterManifest;
  /** Bring the app up. `roles` are the scenario's DECLARED roles, including
   * their `seedRole` (方案 §3.3 规则 7): an adapter that can seed initial
   * business state (占用初始名额的持有者) must honor it here, because
   * `registerAccounts` only creates accounts and cannot retroactively occupy a
   * slot. An adapter that ignores `roles` must declare that limitation. */
  setupEnv(opts: {
    runDir: string;
    seed: number;
    dataRoot: string;
    roles: Role[];
  }): Promise<EnvSummary>;
  registerAccounts(roles: Role[]): Promise<void>;
  runStep(step: Step, ctx: StepContext): Promise<Attempt>;
  /** Submit a barrier group concurrently; one Attempt per step, in order. */
  runBarrier(steps: Step[], ctx: StepContext): Promise<Attempt[]>;
  observe(observerId: string): Promise<ObserverReading>;
  captureEvidence(kind: EvidenceKind, actor?: string): Promise<EvidenceRef>;
  /** Tear down every resource this run owns; returns the torn-down paths. */
  teardown(): Promise<string[]>;
}
