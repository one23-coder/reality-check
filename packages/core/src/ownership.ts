/** Ownership ledger (方案 §10 数据隔离铁律).
 *
 * Every resource the tool creates is registered with `ownedBy: runId`.
 * Cleanup touches ONLY ledger entries owned by the current run. A duplicate
 * registration aborts immediately — code that would mask ownership mistakes
 * must not run (方案 §3.3 规则 8). A data root that already has content but
 * no ownership marker is refused (§10: 已有内容但无所有权标记时拒绝运行).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { configError, internalError } from "./errors.js";

export const OWNERSHIP_FILE = "ownership.json";

export interface OwnershipEntry {
  resource: string;
  kind: "dir" | "file" | "db" | "account";
  ownedBy: string;
  createdAt: string;
}

export interface OwnershipLedger {
  protocol: { ownership: "1.0" };
  runId: string;
  /** Absolute path of the data root this ledger governs. */
  dataRoot: string;
  entries: OwnershipEntry[];
}

export function emptyLedger(runId: string, dataRoot: string): OwnershipLedger {
  return {
    protocol: { ownership: "1.0" },
    runId,
    dataRoot: resolve(dataRoot),
    entries: [],
  };
}

/** Absolute path must stay inside dataRoot; escapes are config errors. */
export function insideRoot(dataRoot: string, target: string): boolean {
  const rel = relative(resolve(dataRoot), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export class OwnershipRegistry {
  private readonly byResource = new Map<string, OwnershipEntry>();

  constructor(private readonly ledger: OwnershipLedger) {
    for (const entry of ledger.entries) {
      if (this.byResource.has(entry.resource))
        throw internalError(`duplicate ownership registration at load: ${entry.resource}`);
      this.byResource.set(entry.resource, entry);
    }
  }

  /** Register a tool-created resource. Duplicate registration aborts (铁律 8). */
  register(kind: OwnershipEntry["kind"], resource: string): void {
    const abs = resolve(resource);
    if (this.byResource.has(abs))
      throw internalError(`resource already registered: ${abs}`);
    if (!insideRoot(this.ledger.dataRoot, abs))
      throw configError(`resource escapes data root: ${abs}`);
    this.byResource.set(abs, {
      resource: abs,
      kind,
      ownedBy: this.ledger.runId,
      createdAt: new Date().toISOString(),
    });
  }

  isOwned(resource: string): boolean {
    return this.byResource.has(resolve(resource));
  }

  ownedCount(): number {
    return this.byResource.size;
  }

  /** Remove every owned resource (dirs recursive, files single). Returns the
   * resources this call ACTUALLY removed — a resource another layer already
   * cleaned is dropped from the ledger but not reported as torn down here, so
   * the event stays truthful; entries created by other runs are never touched. */
  async teardown(): Promise<string[]> {
    const tornDown: string[] = [];
    for (const entry of [...this.byResource.values()].sort((a, b) =>
      b.resource.localeCompare(a.resource),
    )) {
      if (entry.ownedBy !== this.ledger.runId) continue;
      const existed = existsSync(entry.resource);
      await rm(entry.resource, { recursive: entry.kind === "dir" || entry.kind === "db", force: true });
      this.byResource.delete(entry.resource);
      if (existed) tornDown.push(entry.resource);
    }
    this.ledger.entries = [...this.byResource.values()];
    await this.flush();
    return tornDown;
  }

  async flush(): Promise<void> {
    this.ledger.entries = [...this.byResource.values()];
    const file = join(this.ledger.dataRoot, OWNERSHIP_FILE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(this.ledger, null, 2), "utf8");
  }
}

/** Refuse to run against a data root that has content but no ownership file
 * (方案 §10). Returns the loaded ledger when a marker exists. */
export async function claimDataRoot(
  dataRoot: string,
  runId: string,
): Promise<OwnershipRegistry> {
  const root = resolve(dataRoot);
  await mkdir(root, { recursive: true });
  const marker = join(root, OWNERSHIP_FILE);
  let existing: string | undefined;
  try {
    existing = await readFile(marker, "utf8");
  } catch {
    existing = undefined;
  }
  const hasContent = (await readdirSafe(root)).filter((n) => n !== OWNERSHIP_FILE).length > 0;
  if (existing === undefined && hasContent)
    throw configError(
      `data root "${root}" already has content but no ownership marker; refusing to run (方案 §10)`,
    );
  if (existing !== undefined) {
    const prior = JSON.parse(existing) as OwnershipLedger;
    if (prior.runId !== runId && prior.entries.length > 0)
      // 提示必须指向**真实存在**的手段：曾经写的是 "pass --fresh"，但 CLI/MCP/工作台
      // 都没有这个开关（这类"看起来很可行"的错误提示比没有提示更浪费时间）。
      throw configError(
        `data root "${root}" is still owned by run ${prior.runId} (its ledger is non-empty); ` +
          `remove that directory explicitly, or point app/run config at a different data root`,
      );
  }
  const registry = new OwnershipRegistry(emptyLedger(runId, root));
  await registry.flush();
  return registry;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export function newRunId(): string {
  return `rc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
