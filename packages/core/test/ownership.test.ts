import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isRunError } from "../src/errors.js";
import {
  claimDataRoot,
  newRunId,
  OwnershipRegistry,
  OWNERSHIP_FILE,
  type OwnershipLedger,
} from "../src/ownership.js";

const tempDirs: string[] = [];

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rc-ownership-"));
  tempDirs.push(dir);
  return dir;
}

/** Assert fn throws a RunError of exactly `kind` and return it. */
function expectRunError<R>(fn: () => R, kind: "config" | "internal"): void {
  try {
    fn();
  } catch (e) {
    if (!isRunError(e)) assert.fail(`expected RunError, got ${String(e)}`);
    assert.equal(e.kind, kind);
    return;
  }
  assert.fail(`expected RunError of kind ${kind}, but fn did not throw`);
}

async function expectRejectRunError(fn: () => Promise<unknown>, kind: "config" | "internal") {
  try {
    await fn();
  } catch (e) {
    if (!isRunError(e)) assert.fail(`expected RunError, got ${String(e)}`);
    assert.equal(e.kind, kind);
    return;
  }
  assert.fail(`expected rejected RunError of kind ${kind}, but promise resolved`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("OwnershipRegistry", () => {
  it("refuses duplicate registration", async () => {
    const root = await makeTemp();
    const registry = new OwnershipRegistry({
      protocol: { ownership: "1.0" },
      runId: newRunId(),
      dataRoot: root,
      entries: [],
    });
    const file = join(root, "db.sqlite");
    registry.register("db", file);
    expectRunError(() => registry.register("db", file), "internal");
  });

  it("refuses resources outside the data root", async () => {
    const root = await makeTemp();
    const registry = new OwnershipRegistry({
      protocol: { ownership: "1.0" },
      runId: newRunId(),
      dataRoot: root,
      entries: [],
    });
    const outside = join(await makeTemp(), "escaped.txt");
    expectRunError(() => registry.register("file", outside), "config");
  });

  it("teardown removes only entries owned by this run", async () => {
    const root = await makeTemp();
    const runId = newRunId();
    const ownFile = join(root, "own-file.txt");
    const foreignFile = join(root, "foreign-file.txt");
    await writeFile(ownFile, "own", "utf8");
    await writeFile(foreignFile, "foreign", "utf8");
    // A ledger containing one foreign-run entry plus one own entry.
    const createdAt = new Date().toISOString();
    const ledger: OwnershipLedger = {
      protocol: { ownership: "1.0" },
      runId,
      dataRoot: root,
      entries: [
        { resource: foreignFile, kind: "file", ownedBy: "rc-other-run", createdAt },
        { resource: ownFile, kind: "file", ownedBy: runId, createdAt },
      ],
    };
    const registry = new OwnershipRegistry(ledger);
    const tornDown = await registry.teardown();
    assert.deepEqual(tornDown.sort(), [ownFile].sort());
    await assert.rejects(readFile(ownFile));
    assert.equal(await readFile(foreignFile, "utf8"), "foreign");
    // Flushed ledger keeps only the untouched foreign entry.
    const flushed = JSON.parse(await readFile(join(root, OWNERSHIP_FILE), "utf8")) as OwnershipLedger;
    assert.deepEqual(
      flushed.entries.map((e) => e.resource),
      [foreignFile],
    );
  });
});

describe("claimDataRoot", () => {
  it("accepts an empty root and writes the marker", async () => {
    const root = await makeTemp();
    const runId = newRunId();
    const registry = await claimDataRoot(root, runId);
    assert.equal(registry.ownedCount(), 0);
    const marker = JSON.parse(await readFile(join(root, OWNERSHIP_FILE), "utf8")) as OwnershipLedger;
    assert.equal(marker.runId, runId);
  });

  it("refuses content without an ownership marker", async () => {
    const root = await makeTemp();
    await writeFile(join(root, "someone-elses-data.txt"), "not ours", "utf8");
    await expectRejectRunError(() => claimDataRoot(root, newRunId()), "config");
  });

  it("refuses a root owned by a different run with entries", async () => {
    const root = await makeTemp();
    const priorRun = newRunId();
    const priorFile = join(root, "prior.txt");
    await writeFile(priorFile, "prior run data", "utf8");
    const registry = new OwnershipRegistry({
      protocol: { ownership: "1.0" },
      runId: priorRun,
      dataRoot: root,
      entries: [],
    });
    registry.register("file", priorFile);
    await registry.flush();
    await expectRejectRunError(() => claimDataRoot(root, newRunId()), "config");
  });
});

describe("newRunId", () => {
  it("produces distinct ids", () => {
    const a = newRunId();
    const b = newRunId();
    assert.notEqual(a, b);
    assert.match(a, /^rc-/);
  });
});
