/** Run artifact layout, version 1.0 (方案 §3.1 运行产物 1.0).
 *
 * runs/<runId>/
 *   run.json        run manifest (versions, seed, scenario sha)
 *   events.jsonl    append-only timeline; seq is the ONLY ordering authority
 *   result.json     final RunResult (verdict + rule evaluations + evidence refs)
 *   evidence/       files the adapter wrote; kernel verifies existence on register
 *   ownership.json  ownership ledger for this run's data root
 *
 * §4 铁律 3: evidence is written by the adapter into the run dir; the kernel
 * refuses to register a ref whose file does not exist. Placeholder content
 * is never evidence.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS_VERSION } from "@reality-check/protocol";
import { internalError } from "./errors.js";

export const RUN_MANIFEST = "run.json";
export const EVENTS_FILE = "events.jsonl";
export const RESULT_FILE = "result.json";
export const EVIDENCE_DIR = "evidence";
export const OWNERSHIP_FILE = "ownership.json";

export interface RunManifest {
  protocol: { runArtifacts: typeof ARTIFACTS_VERSION };
  runId: string;
  scenarioId: string;
  scenarioSha256: string;
  seed: number;
  startedAt: string;
  versions: Record<string, string>;
  platform: string;
}

export interface TimelineEvent {
  seq: number;
  t: string;
  kind: string;
  actor?: string;
  detail: Record<string, unknown>;
  /** Causal edge: seq of the event that caused this one (§10: seq 排序,
   * causationId 才是因果边). */
  causation?: number;
}

export class RunDir {
  readonly eventsPath: string;
  readonly evidenceDir: string;
  private nextSeq = 0;
  private readonly events: TimelineEvent[] = [];

  constructor(
    readonly dir: string,
    private readonly manifest: RunManifest,
  ) {
    this.eventsPath = join(dir, EVENTS_FILE);
    this.evidenceDir = join(dir, EVIDENCE_DIR);
  }

  static async create(dir: string, manifest: RunManifest): Promise<RunDir> {
    const runDir = new RunDir(dir, manifest);
    await mkdir(runDir.evidenceDir, { recursive: true });
    await writeFile(
      join(dir, RUN_MANIFEST),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    return runDir;
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
    this.events.push(e);
    await appendFile(this.eventsPath, `${JSON.stringify(e)}\n`, "utf8");
    return e;
  }

  allEvents(): readonly TimelineEvent[] {
    return this.events;
  }

  /** Evidence path for a new artifact file. */
  evidencePath(name: string): string {
    return join(this.evidenceDir, name);
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.dir, name), JSON.stringify(value, null, 2), "utf8");
  }

  sha256Of(file: string): string {
    return createHash("sha256").update(file).digest("hex");
  }
}

export function readEventsSync(runDir: string): TimelineEvent[] {
  try {
    const raw = readFile(join(runDir, EVENTS_FILE), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as TimelineEvent);
  } catch (e) {
    throw internalError(`cannot read ${EVENTS_FILE} in ${runDir}`, e);
  }
}
