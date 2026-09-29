/** Run artifact layout, version 1.0 (方案 §3.1 运行产物 1.0).
 *
 * runs/<runId>/
 *   run.json        run manifest (versions, seed, scenario sha)
 *   events.jsonl    append-only timeline; seq is the ONLY ordering authority
 *   result.json     final RunResult (verdict + rule evaluations + evidence refs)
 *   evidence/       files the adapter wrote; kernel verifies existence on register
 *   ownership.json  ownership ledger for this run's data root (see ownership.ts)
 *
 * §4 铁律 3: evidence is written by the adapter into the run dir; the kernel
 * refuses to register a ref whose file does not exist. Placeholder content
 * is never evidence.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ARTIFACTS_VERSION,
  type EvidenceKind,
  type EvidenceRef,
  type RunResult,
  type TimelineEvent,
} from "@rc/protocol";
import { internalError } from "./errors.js";

export const RUN_MANIFEST = "run.json";
export const EVENTS_FILE = "events.jsonl";
export const RESULT_FILE = "result.json";
export const EVIDENCE_DIR = "evidence";

export interface RunManifest {
  protocol: { artifacts: typeof ARTIFACTS_VERSION };
  runId: string;
  scenarioId: string;
  scenarioSha256: string;
  seed: number;
  startedAt: string;
  versions: Record<string, string>;
  platform: string;
}

export class RunArtifacts {
  readonly dir: string;
  readonly evidenceDir: string;
  readonly startedAt: string;
  private readonly eventsPath: string;
  private nextSeq = 0;
  private nextEvidenceSeq = 0;
  private readonly eventLog: TimelineEvent[] = [];

  private constructor(
    dir: string,
    private readonly manifest: RunManifest,
  ) {
    this.dir = dir;
    this.evidenceDir = join(dir, EVIDENCE_DIR);
    this.eventsPath = join(dir, EVENTS_FILE);
    this.startedAt = manifest.startedAt;
  }

  /** Create the run directory tree and write run.json. */
  static async create(
    runsRoot: string,
    runId: string,
    manifest: {
      scenarioId: string;
      scenarioSha256: string;
      seed: number;
      versions: Record<string, string>;
      platform: string;
    },
  ): Promise<RunArtifacts> {
    const dir = join(resolve(runsRoot), runId);
    const runManifest: RunManifest = {
      protocol: { artifacts: ARTIFACTS_VERSION },
      runId,
      scenarioId: manifest.scenarioId,
      scenarioSha256: manifest.scenarioSha256,
      seed: manifest.seed,
      startedAt: new Date().toISOString(),
      versions: manifest.versions,
      platform: manifest.platform,
    };
    const artifacts = new RunArtifacts(dir, runManifest);
    await mkdir(artifacts.evidenceDir, { recursive: true });
    await writeFile(join(dir, RUN_MANIFEST), JSON.stringify(runManifest, null, 2), "utf8");
    return artifacts;
  }

  /** Append an event; seq is assigned here and is strictly monotonic. */
  async event(
    kind: string,
    detail: Record<string, unknown>,
    opts: { actor?: string; causation?: number } = {},
  ): Promise<TimelineEvent> {
    const e: TimelineEvent = {
      seq: this.nextSeq++,
      t: new Date().toISOString(),
      kind,
      detail,
    };
    if (opts.actor !== undefined) e.actor = opts.actor;
    if (opts.causation !== undefined) e.causation = opts.causation;
    this.eventLog.push(e);
    await appendFile(this.eventsPath, `${JSON.stringify(e)}\n`, "utf8");
    return e;
  }

  /** Timeline so far; seq order is the only ordering authority (方案 §10). */
  events(): readonly TimelineEvent[] {
    return this.eventLog;
  }

  /** Register an evidence file. `file` may be absolute (under the run's
   * evidence dir) or relative to the run dir. The file must exist —
   * placeholder content is never evidence (方案 §4 铁律 3). */
  async evidence(kind: EvidenceKind, file: string, actor?: string): Promise<EvidenceRef> {
    const abs = isAbsolute(file) ? resolve(file) : resolve(this.dir, file);
    const relToEvidence = relative(this.evidenceDir, abs);
    const relToRun = relative(this.dir, abs);
    if (relToEvidence === "" || relToEvidence.startsWith("..") || isAbsolute(relToEvidence))
      throw internalError(`evidence file "${file}" is not under ${this.evidenceDir}`);
    let size: number;
    try {
      const s = await stat(abs);
      if (!s.isFile()) throw new Error("not a regular file");
      size = s.size;
    } catch (e) {
      throw internalError(`evidence file "${abs}" does not exist; refusing to register`, e);
    }
    if (size === 0) throw internalError(`evidence file "${abs}" is empty (placeholder content)`);
    const sha256 = createHash("sha256").update(await readFile(abs)).digest("hex");
    const ref: EvidenceRef = {
      kind,
      file: relToRun.split(sep).join("/"),
      seq: this.nextEvidenceSeq++,
      sha256,
    };
    if (actor !== undefined) ref.actor = actor;
    return ref;
  }

  /** Write the final result.json. */
  async writeResult(result: RunResult): Promise<void> {
    await writeFile(join(this.dir, RESULT_FILE), JSON.stringify(result, null, 2), "utf8");
  }
}
