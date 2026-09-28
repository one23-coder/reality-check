/** Adapter manifest, version 1.0 (方案 §3 六套协议之「适配清单 1.0」).
 *
 * The manifest is the adapter's capability contract: which scenario ops it
 * implements, which assertion ops it can judge, which tables its observers
 * may read, which evidence kinds it can produce, and whether it can run
 * barrier groups. The kernel refuses a scenario the manifest cannot serve
 * (exit 64) before any environment is created.
 */
import {
  vArray,
  vBool,
  vEnum,
  vLiteral,
  vObject,
  vRecord,
  vString,
  type V,
} from "./v.js";
import { MANIFEST_VERSION } from "./versions.js";

export { MANIFEST_VERSION };

/** Evidence kinds an adapter can produce. SQL dumps and page text are the
 * minimum; screenshots are expected from browser adapters. */
export const EVIDENCE_KINDS = [
  "screenshot",
  "dom-snapshot",
  "har",
  "sql-dump",
  "page-text",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface AdapterManifest {
  protocol: { manifest: typeof MANIFEST_VERSION };
  adapterId: string;
  adapterVersion: string;
  /** Scenario protocol version this adapter serves. */
  scenarioVersion: string;
  supportedOps: string[];
  supportedAssertions: string[];
  /** Whitelist of tables observers may read (SQL 层只读白名单, §3.3 规则 1). */
  observedTables: string[];
  evidenceKinds: EvidenceKind[];
  /** True when the adapter can submit barrier step groups concurrently. */
  barriers: boolean;
  /** Adapter-provided observers keyed by id (断言主体必须复用这些 SQL). */
  observers: Record<string, { sql: string; tables: string[]; columns: string[] }>;
}

const manifestV: V<AdapterManifest> = vObject<AdapterManifest>({
  required: {
    protocol: vObject({
      required: { manifest: vLiteral(MANIFEST_VERSION) },
    }),
    adapterId: vString,
    adapterVersion: vString,
    scenarioVersion: vString,
    supportedOps: vArray(vString, { min: 1 }),
    supportedAssertions: vArray(vString, { min: 1 }),
    observedTables: vArray(vString, { min: 1 }),
    evidenceKinds: vArray(vEnum<EvidenceKind>(EVIDENCE_KINDS), { min: 1 }),
    barriers: vBool,
    observers: vRecord(
      vObject({
        required: { sql: vString, tables: vArray(vString, { min: 1 }), columns: vArray(vString, { min: 1 }) },
      }),
    ),
  },
});

export function validateManifest(value: unknown, source: string): AdapterManifest {
  return manifestV(value, source);
}
