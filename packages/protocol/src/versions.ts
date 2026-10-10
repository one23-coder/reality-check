/** Single source of truth for all protocol versions (方案 §3 六套版本化协议). */
export const SCENARIO_VERSION = "1.1";
export const RESULT_VERSION = "1.1";
export const MANIFEST_VERSION = "1.0";
export const ADAPTER_IFACE_VERSION = "1.0";
export const ARTIFACTS_VERSION = "1.0";
export const TOOLS_VERSION = "0.1.0";

/** Versions the kernel can execute.
 *
 * 1.1 adds two things on top of 1.0 (方案 §3.3 规则 22):
 *   - `Step.when` 条件步骤（条件为假 ⇒ 该步 `skipped`，不是失败也不是通过）；
 *   - `Attempt.outcome === "skipped"` 这一新取值。
 * 1.0 文档仍然可执行：没有 `when`、不产生 `skipped`，判定语义完全不变。 */
export const SUPPORTED_SCENARIO_VERSIONS = ["1.0", "1.1"] as const;

export type ScenarioVersion = (typeof SUPPORTED_SCENARIO_VERSIONS)[number];

export function isSupportedScenarioVersion(version: string): version is ScenarioVersion {
  return (SUPPORTED_SCENARIO_VERSIONS as readonly string[]).includes(version);
}

/** Does a component declaring `served` cover a document requiring `required`?
 * Unknown versions are never covered (fail closed). */
export function scenarioVersionAtLeast(served: string, required: string): boolean {
  const i = (SUPPORTED_SCENARIO_VERSIONS as readonly string[]).indexOf(served);
  const j = (SUPPORTED_SCENARIO_VERSIONS as readonly string[]).indexOf(required);
  return i >= 0 && j >= 0 && i >= j;
}

export const ALL_VERSIONS = {
  scenario: SCENARIO_VERSION,
  result: RESULT_VERSION,
  manifest: MANIFEST_VERSION,
  adapterInterface: ADAPTER_IFACE_VERSION,
  runArtifacts: ARTIFACTS_VERSION,
  tools: TOOLS_VERSION,
} as const;
