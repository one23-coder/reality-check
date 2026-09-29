/** @rc/adapter-sdk — the stable "adapter kit" import point (方案 §8).
 *
 * External adapter authors import EVERYTHING from here: the contract types
 * (re-exported from @rc/core and @rc/protocol), the batteries in helpers.js,
 * the conformance suite, and a demo app. See docs/adapter-sdk.md for the
 * authoring guide — that file, not the kernel source, is the documentation.
 */

// ---- contract types (what an adapter implements / consumes) ----------------
export type { LocalWebAdapterV1, StepContext, ObserverReading } from "@rc/core";
export type {
  AdapterManifest,
  Attempt,
  EnvSummary,
  EvidenceKind,
  EvidenceRef,
  Observer,
  Role,
  Scenario,
  Step,
} from "@rc/protocol";
export { EVIDENCE_KINDS, SCENARIO_VERSION, MANIFEST_VERSION, STEP_OPS, validateManifest } from "@rc/protocol";

// ---- batteries --------------------------------------------------------------
export {
  extractSqlTables,
  freePort,
  freshSqliteRead,
  sha256File,
  spawnApp,
  waitForHealth,
  writeEvidenceFile,
  type SpawnedApp,
  type WriteEvidenceOptions,
} from "./helpers.js";

// ---- conformance suite -------------------------------------------------------
export { runConformanceSuite, type CheckResult, type ConformanceOptions, type ConformanceReport } from "./conformance.js";

// ---- zero-dep demo app (the "third app") ------------------------------------
export { startStaticApp, type StaticApp, type StaticAppOptions } from "./static-app.js";
