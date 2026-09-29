/** @rc/workbench — 本地演练工作台 (方案 §6). Re-exports the server so tests
 * and future hosts embed it; bin rc-workbench (main.ts) runs it standalone. */
export {
  startWorkbench,
  assertStaticUi,
  DEFAULT_PORT,
  DEFAULT_HOST,
  type WorkbenchOptions,
  type WorkbenchServer,
} from "./server.js";
export { applyOverrides, buildDraft, looksLikeInjection, OverrideError, type RunOverrides } from "./overrides.js";
export { listRuns, listScenarios, loadScenarioById, readRunDetail, type RunSummary, type ScenarioSummary } from "./store.js";
