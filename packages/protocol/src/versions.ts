/** Single source of truth for all protocol versions (方案 §3 六套版本化协议). */
export const SCENARIO_VERSION = "1.0";
export const RESULT_VERSION = "1.0";
export const MANIFEST_VERSION = "1.0";
export const ADAPTER_IFACE_VERSION = "1.0";
export const ARTIFACTS_VERSION = "1.0";
export const TOOLS_VERSION = "0.1.0";

export const ALL_VERSIONS = {
  scenario: SCENARIO_VERSION,
  result: RESULT_VERSION,
  manifest: MANIFEST_VERSION,
  adapterInterface: ADAPTER_IFACE_VERSION,
  runArtifacts: ARTIFACTS_VERSION,
  tools: TOOLS_VERSION,
} as const;
