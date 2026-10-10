import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RunResult } from "@rc/protocol";
import { internalError, isRunError } from "../src/errors.js";
import { EVIDENCE_DIR, EVENTS_FILE, RunArtifacts } from "../src/artifacts.js";

const tempRoots: string[] = [];

async function makeArtifacts(): Promise<RunArtifacts> {
  const runsRoot = await mkdtemp(join(tmpdir(), "rc-artifacts-"));
  tempRoots.push(runsRoot);
  return RunArtifacts.create(runsRoot, "rc-test-run", {
    scenarioId: "s1",
    scenarioSha256: "deadbeef",
    seed: 7,
    versions: { scenario: "1.0" },
    platform: "test",
  });
}

function minimalResult(): RunResult {
  return {
    protocol: { result: "1.1" },
    runId: "rc-test-run",
    scenarioId: "s1",
    scenarioSha256: "deadbeef",
    seed: 7,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    verdict: "passed",
    ruleEvaluations: [],
    timeline: [],
    attempts: [],
    env: {
      appVersion: "1",
      adapterVersion: "1",
      baseUrl: "http://127.0.0.1:0",
      seed: 7,
      platform: "test",
    },
    evidence: [],
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("RunArtifacts.evidence", () => {
  it("refuses to register a missing file (方案 §4 铁律 3)", async () => {
    const artifacts = await makeArtifacts();
    await assert.rejects(
      () => artifacts.evidence("screenshot", "evidence/no-such-shot.png"),
      (e: unknown) => {
        assert.ok(isRunError(e));
        assert.equal((e as ReturnType<typeof internalError>).kind, "internal");
        return true;
      },
    );
  });

  it("registers an existing evidence file with its content hash", async () => {
    const artifacts = await makeArtifacts();
    const file = join(artifacts.evidenceDir, "dump.txt");
    await writeFile(file, "observed rows", "utf8");
    const ref = await artifacts.evidence("sql-dump", file, "holder");
    assert.equal(ref.kind, "sql-dump");
    assert.equal(ref.file, `${EVIDENCE_DIR}/dump.txt`);
    assert.equal(ref.seq, 0);
    assert.equal(ref.actor, "holder");
    assert.match(ref.sha256, /^[0-9a-f]{64}$/);
    const again = await artifacts.evidence("sql-dump", "evidence/dump.txt");
    assert.equal(again.seq, 1);
    assert.equal(again.sha256, ref.sha256);
  });

  it("refuses files outside the evidence dir", async () => {
    const artifacts = await makeArtifacts();
    const outside = join(artifacts.dir, "..", "elsewhere.txt");
    await writeFile(outside, "not evidence", "utf8");
    await assert.rejects(() => artifacts.evidence("page-text", outside), isRunError);
  });
});

describe("RunArtifacts.event seq", () => {
  it("assigns strictly monotonic seqs across awaited and concurrent appends", async () => {
    const artifacts = await makeArtifacts();
    await artifacts.event("run-started", {});
    await Promise.all([
      artifacts.event("step", { n: 1 }),
      artifacts.event("step", { n: 2 }),
      artifacts.event("step", { n: 3 }),
    ]);
    await artifacts.event("verdict", {});
    const seqs = artifacts.events().map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1];
      const cur = seqs[i];
      assert.ok(prev !== undefined && cur !== undefined && cur === prev + 1, `seqs: ${seqs}`);
    }
    assert.equal(seqs[0], 0);
    assert.equal(seqs.length, 5);
  });

  it("keeps causation edges on the event", async () => {
    const artifacts = await makeArtifacts();
    const cause = await artifacts.event("observe", { observerId: "o1" });
    const effect = await artifacts.event("assert", { assertionId: "a1" }, { causation: cause.seq });
    assert.equal(effect.causation, cause.seq);
  });
});

describe("RunArtifacts.verifyEvidenceRef", () => {
  it("accepts a ref whose file exists under evidence/ with a matching hash", async () => {
    const artifacts = await makeArtifacts();
    const file = join(artifacts.evidenceDir, "dump.json");
    await writeFile(file, '{"rows":[]}', "utf8");
    const ref = await artifacts.evidence("sql-dump", file);
    assert.equal(await artifacts.verifyEvidenceRef(ref), null);
  });

  it("names a dangling reference instead of trusting it (方案 §4 铁律 3)", async () => {
    const artifacts = await makeArtifacts();
    await writeFile(join(artifacts.evidenceDir, "dump.json"), "rows", "utf8");
    const real = await artifacts.evidence("sql-dump", "evidence/dump.json");
    const ghost = { ...real, file: "evidence/ghost.json" };
    assert.match(String(await artifacts.verifyEvidenceRef(ghost)), /does not exist/);
  });

  it("rejects an empty file as placeholder content", async () => {
    const artifacts = await makeArtifacts();
    const file = join(artifacts.evidenceDir, "empty.txt");
    await writeFile(file, "", "utf8");
    const ref = { kind: "page-text" as const, file: "evidence/empty.txt", seq: 0, sha256: "x" };
    assert.match(String(await artifacts.verifyEvidenceRef(ref)), /is empty/);
  });

  it("rejects a ref whose sha256 does not match the file's content", async () => {
    const artifacts = await makeArtifacts();
    const file = join(artifacts.evidenceDir, "dump.json");
    await writeFile(file, "rows", "utf8");
    const real = await artifacts.evidence("sql-dump", file);
    await writeFile(file, "rows tampered with after registration", "utf8");
    assert.match(String(await artifacts.verifyEvidenceRef(real)), /sha256 mismatch/);
  });

  it("rejects paths that escape the run dir or leave evidence/", async () => {
    const artifacts = await makeArtifacts();
    const escaping = {
      kind: "sql-dump" as const,
      file: "../outside.json",
      seq: 0,
      sha256: "x",
    };
    assert.match(String(await artifacts.verifyEvidenceRef(escaping)), /escapes the run directory/);
    const insideRunOnly = { kind: "screenshot" as const, file: "run.json", seq: 0, sha256: "x" };
    assert.match(String(await artifacts.verifyEvidenceRef(insideRunOnly)), /outside evidence\//);
  });
});

describe("RunArtifacts layout", () => {
  it("writes run.json and result.json under the run dir", async () => {
    const artifacts = await makeArtifacts();
    await artifacts.writeResult(minimalResult());
    const { readFile } = await import("node:fs/promises");
    const runJson = JSON.parse(await readFile(join(artifacts.dir, "run.json"), "utf8")) as {
      protocol: { artifacts: string };
      runId: string;
      seed: number;
    };
    assert.equal(runJson.protocol.artifacts, "1.0");
    assert.equal(runJson.runId, "rc-test-run");
    assert.equal(runJson.seed, 7);
    const resultJson = JSON.parse(await readFile(join(artifacts.dir, "result.json"), "utf8")) as RunResult;
    assert.equal(resultJson.verdict, "passed");
    // events.jsonl exists on disk once an event was appended
    await artifacts.event("run-started", {});
    const lines = (await readFile(join(artifacts.dir, EVENTS_FILE), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? "").kind, "run-started");
  });
});
