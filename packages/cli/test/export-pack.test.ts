/** 脱敏证据包导出 (export --run-id <id> --pack <dir>) 的端到端行为：
 * 已知敏感值（场景角色账号、db 绝对路径、运行目录）逐字替换 + 模式兜底；
 * 二进制证据默认排除并写明原因；导出后独立反扫，任何残留都不允许产出。 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { exportCommand } from "../src/commands/export.js";
import type { CommandResult } from "../src/config.js";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makeTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-pack-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeConfig(dir: string): Promise<string> {
  const file = path.join(dir, ".reality-check.json");
  await fsp.writeFile(
    file,
    JSON.stringify(
      {
        tools: "0.1.0",
        app: { kind: "local-web", entry: "unused-by-pack.js" },
        adapter: { module: "@rc/adapter-local-web" },
        runsDir: path.join(dir, "runs"),
        scenariosDir: path.join(dir, "scenarios"),
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

/** A synthetic run dir with everything a real run has — plus planted secrets. */
async function makeRun(dir: string): Promise<{ runId: string; dbPath: string }> {
  const runId = "rc-packtest-0001";
  const runDir = path.join(dir, "runs", runId);
  const dataDir = path.join(runDir, "data");
  const dbPath = path.join(dataDir, "app.db");
  await fsp.mkdir(path.join(runDir, "evidence"), { recursive: true });
  await fsp.mkdir(path.join(dir, "scenarios"), { recursive: true });

  const scenarioPath = path.join(dir, "scenarios", "demo.json");
  await fsp.writeFile(
    scenarioPath,
    JSON.stringify({
      protocol: { scenario: "1.1" },
      id: "demo",
      name: "demo",
      description: "d",
      app: "demo",
      seed: 1,
      roles: [{ id: "alice", account: { username: "alice_rc", password: "pw-alice" }, seedRole: "none" }],
      steps: [{ id: "s1", actor: "alice", op: "navigate", params: { path: "/" } }],
      observers: [{ id: "count", sql: "SELECT COUNT(*) AS n FROM t", tables: ["t"], expectColumns: ["n"] }],
      assertions: [{ id: "a1", rule: "r1", observer: "count", op: "eq", value: 1 }],
      rules: [{ id: "r1", description: "r" }],
    }),
    "utf8",
  );

  await fsp.writeFile(
    path.join(runDir, "result.json"),
    JSON.stringify({
      protocol: { result: "1.1" },
      runId,
      scenarioId: "demo",
      scenarioSha256: "a".repeat(64),
      seed: 1,
      startedAt: "2026-10-10T10:00:00.000Z",
      finishedAt: "2026-10-10T10:00:01.000Z",
      verdict: "passed",
      ruleEvaluations: [
        { ruleId: "r1", assertionId: "a1", verdict: "held", observed: 1, expected: "eq 1", evidenceRefs: [] },
      ],
      timeline: [{ seq: 1, t: "2026-10-10T10:00:00.500Z", kind: "step", detail: { banner: "登录成功（alice_rc）" } }],
      attempts: [
        { stepId: "s1", actor: "alice", op: "navigate", outcome: "completed", detail: { banner: "登录成功（alice_rc）" } },
      ],
      env: { appVersion: "1", adapterVersion: "1", baseUrl: "http://127.0.0.1:54432", seed: 1, platform: "test", dbPath },
      evidence: [],
    }),
    "utf8",
  );
  await fsp.writeFile(
    path.join(runDir, "events.jsonl"),
    `${JSON.stringify({ seq: 1, t: "2026-10-10T10:00:00.500Z", kind: "step", detail: { banner: "登录成功（alice_rc）", dbPath } })}\n`,
    "utf8",
  );
  await fsp.writeFile(
    path.join(runDir, "report.html"),
    `<html><body>run ${runId} account alice_rc db ${dbPath} http://127.0.0.1:54432/healthz</body></html>`,
    "utf8",
  );
  await fsp.writeFile(path.join(runDir, "run.json"), JSON.stringify({ runId, scenarioId: "demo" }), "utf8");
  await fsp.writeFile(path.join(runDir, "cli.json"), JSON.stringify({ scenarioPath, seed: 1 }), "utf8");
  await fsp.writeFile(
    path.join(runDir, "evidence", "obs-count-1.json"),
    // bob_rc is NOT a scenario role: only the account-token pattern can catch it.
    JSON.stringify({
      sql: "SELECT COUNT(*) AS n FROM t",
      rows: [{ n: 1, account: "alice_rc" }, { account: "bob_rc" }],
    }),
    "utf8",
  );
  // A binary evidence file: pixels cannot be scrubbed by text rules.
  await fsp.writeFile(path.join(runDir, "evidence", "step-1-alice.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return { runId, dbPath };
}

async function allTextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  };
  await walk(root);
  return out;
}

async function runCmd(args: string[]): Promise<CommandResult> {
  return exportCommand(args);
}

describe("export --pack (脱敏证据包)", () => {
  it("produces a leak-free pack: known secrets and paths never survive", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const { runId, dbPath } = await makeRun(dir);
    const packsDir = path.join(dir, "packs");

    const res = await runCmd(["--run-id", runId, "--pack", packsDir, "--config", config]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /leak scan: clean/);

    const packDir = path.join(packsDir, `${runId}-pack`);
    // Every text file in the pack is scanned for the planted secrets.
    for (const abs of await allTextFiles(packDir)) {
      if (abs.endsWith(".png")) continue;
      const content = await fsp.readFile(abs, "utf8");
      assert.doesNotMatch(content, /alice_rc/, `${abs} leaks an account name`);
      assert.doesNotMatch(content, /\bbob_rc\b/, `${abs} leaks a non-scenario account name`);
      assert.doesNotMatch(content, new RegExp(dbPath.replaceAll("\\", "\\\\"), "u"), `${abs} leaks the db path`);
      assert.doesNotMatch(content, /127\.0\.0\.1:54432/, `${abs} leaks the run port`);
      assert.doesNotMatch(content, new RegExp(dir.replaceAll("\\", "\\\\"), "u"), `${abs} leaks an internal path`);
    }

    const manifest = JSON.parse(await fsp.readFile(path.join(packDir, "pack.json"), "utf8")) as {
      files: { path: string; kind: string; sha256: string; sanitized: boolean }[];
      redactions: { rule: string; count: number }[];
      excluded: { path: string; reason: string }[];
      leakScan: { secrets: number; clean: boolean };
    };
    assert.ok(manifest.files.length >= 5, "result/events/report/evidence/pack must be listed");
    assert.ok(manifest.files.every((f) => f.sha256.length === 64));
    const rules = manifest.redactions.map((r) => r.rule);
    assert.ok(rules.includes("known-secret"), `known-secret must fire (got ${rules.join(",")})`);
    // bob_rc was not a known secret, so the account-token pattern must have caught it.
    assert.ok(rules.includes("account-token"), `account-token must fire (got ${rules.join(",")})`);
    assert.ok(rules.includes("loopback-port"));
    assert.ok(manifest.leakScan.clean === true);

    // Binary evidence is excluded by default, with the reason on record.
    const excludedPaths = manifest.excluded.map((e) => e.path);
    assert.ok(excludedPaths.includes("evidence/step-1-alice.png"));
    assert.match(manifest.excluded[0]?.reason ?? "", /无法用文本规则脱敏/);
    assert.equal(await fsp.stat(packDir).then(() => true), true);
    await assert.rejects(() => fsp.readFile(path.join(packDir, "evidence", "step-1-alice.png")));
  });

  it("--include-images ships binaries explicitly marked unsanitized", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const { runId } = await makeRun(dir);
    const res = await runCmd([
      "--run-id",
      runId,
      "--pack",
      path.join(dir, "packs"),
      "--config",
      config,
      "--include-images",
    ]);
    assert.equal(res.code, 0, res.stderr);
    const packDir = path.join(dir, "packs", `${runId}-pack`);
    const png = await fsp.readFile(path.join(packDir, "evidence", "step-1-alice.png"));
    assert.equal(png.length, 7);
    const manifest = JSON.parse(await fsp.readFile(path.join(packDir, "pack.json"), "utf8")) as {
      files: { path: string; sanitized: boolean }[];
      excluded: unknown[];
    };
    assert.deepEqual(manifest.excluded, []);
    const entry = manifest.files.find((f) => f.path === "evidence/step-1-alice.png");
    assert.equal(entry?.sanitized, false, "an image can never be claimed as sanitized");
  });

  it("refuses --pack without --run-id and unknown runs (exit 64)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const noId = await runCmd(["--pack", path.join(dir, "packs"), "--config", config]);
    assert.equal(noId.code, 64);
    assert.match(noId.stderr, /requires --run-id/);

    const ghost = await runCmd(["--run-id", "rc-ghost", "--pack", path.join(dir, "packs"), "--config", config]);
    assert.equal(ghost.code, 64);
    assert.match(ghost.stderr, /no readable result\.json/);
  });

  it("still lists runs when --pack is absent (existing behavior untouched)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const { runId } = await makeRun(dir);
    const res = await runCmd(["--config", config]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(runId));
  });
});
