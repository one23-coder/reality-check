/** Adapter-facing protocol shapes — re-exported from `@rc/protocol`.
 *
 * These used to be hand-mirrored here, which let them drift silently: a protocol
 * change (say, renaming `Attempt.evidence` or widening `AttemptOutcome` with
 * `skipped`) would still compile and only surface later as a result.json the
 * validator rejects, or worse — as evidence the kernel silently drops. 方案 §3.3
 * 规则 2 says the protocol is the single source of truth, so the mirror is gone.
 *
 * Only `ObserverReading` and `StepContext` stay local: they are kernel-side
 * shapes defined in `@rc/core`, and an adapter must NOT depend on the kernel
 * (that dependency direction is what keeps adapters swappable). */

export type {
  AdapterManifest,
  Attempt,
  AttemptOutcome,
  EnvSummary,
  EvidenceKind,
  EvidenceRef,
  Role,
  SeedRole,
  Step,
  StepOp,
} from "@rc/protocol";

/** One observer's reading. Mirrors `@rc/core`'s `ObserverReading` on purpose:
 * the adapter cannot import the kernel, and structural compatibility is what
 * the adapter boundary is checked against at runtime (see `@rc/adapter-sdk`'s
 * consistency suite). `evidence` is protocol's `EvidenceRef`, so the kernel's
 * verification rules apply to it unchanged. */
export interface ObserverReading {
  observerId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  evidence: import("@rc/protocol").EvidenceRef[];
}

/** Per-step callback surface handed to the adapter by the kernel. */
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
