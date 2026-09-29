/** Reality Check protocol barrel (方案 §3.1: 六套版本化协议). */
export * from "./versions.js";
export * from "./exit-codes.js";
export * from "./scenario.js";
export * from "./result.js";
export * from "./v.js";
export { EVIDENCE_KINDS, validateManifest, type AdapterManifest } from "./manifest.js";

// Explicit re-exports resolve ambiguous `export *` members (TS2308):
export { SCENARIO_VERSION } from "./versions.js";
export { VERDICT_EXIT, type Verdict } from "./exit-codes.js";
