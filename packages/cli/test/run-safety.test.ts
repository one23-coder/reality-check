/** CLI 安全与结论语义回归（不启动浏览器）。
 *
 * 1. runId 必须是 runsDir 下的**单段文件名**：`export --pack` 会把
 *    `<out>/<runId>-pack` 递归删除后重写，`..` 在那里是破坏性路径穿越。
 * 2. 侧车/报告写失败**不得**顶掉真实结论（内核已把结论写进 result.json）。
 * 3. events.jsonl 单行损坏只应变成 warning，而不是让整次运行变成 exit 70。
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { RunResult } from "@rc/protocol";
import { isSafeRunId, runIdProblem } from "@rc/protocol";
import { exportCommand } from "../src/commands/export.js";
import { rerunCommand } from "../src/commands/rerun.js";
import { toCommandResult } from "../src/config.js";
import { readEvents, writeRunArtifacts, type RunOutcome } from "../src/runner.js";

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-runid-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function run(fn: (args: string[]) => Promise<{ code: number; stderr: string }>, args: string[]) {
  try {
    return await fn(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

test("runId must be one path segment (shared rule, protocol side)", () => {
  assert.equal(isSafeRunId("rc-mv2cbos9-4b4734d8"), true);
  for (const bad of ["..", ".", "../..", "a/b", "a\\b", "", "x y", "run;rm", null, 42]) {
    assert.equal(isSafeRunId(bad), false, `must reject ${JSON.stringify(bad)}`);
    assert.match(String(runIdProblem(bad)), /run id|runId/);
  }
});

test("export --run-id cannot traverse out of --pack (it rm -rf's that path)", async () => {
  const dir = await makeTmp();
  const cfg = path.join(dir, ".reality-check.json");
  await fsp.writeFile(
    cfg,
    JSON.stringify({
      tools: "0.1.0",
      app: { kind: "local-web", entry: path.join(dir, "server.js") },
      adapter: { module: "@reality-check/adapter-local-web" },
      runsDir: path.join(dir, "runs"),
      scenariosDir: path.join(dir, "scenarios"),
    }),
    "utf8",
  );
  const victim = path.join(dir, "victim");
  await fsp.mkdir(path.join(victim, "keep"), { recursive: true });
  await fsp.writeFile(path.join(victim, "keep", "important.txt"), "do not delete me", "utf8");

  const res = await run(exportCommand, [
    "--config", cfg,
    "--run-id", `..${path.sep}victim`,
    "--pack", path.join(dir, "out"),
  ]);
  assert.equal(res.code, 64);
  assert.match(res.stderr, /invalid run id/);
  // 关键：越界目录必须原样还在。
  assert.equal(
    await fsp.readFile(path.join(victim, "keep", "important.txt"), "utf8"),
    "do not delete me",
  );
});

test("rerun --run-id is validated the same way", async () => {
  const dir = await makeTmp();
  const cfg = path.join(dir, ".reality-check.json");
  await fsp.writeFile(
    cfg,
    JSON.stringify({
      tools: "0.1.0",
      app: { kind: "local-web", entry: path.join(dir, "server.js") },
      adapter: { module: "@reality-check/adapter-local-web" },
      runsDir: path.join(dir, "runs"),
      scenariosDir: path.join(dir, "scenarios"),
    }),
    "utf8",
  );
  const res = await run(rerunCommand, ["--config", cfg, "--run-id", "../../etc"]);
  assert.equal(res.code, 64);
  assert.match(res.stderr, /invalid run id/);
});

test("sidecar/report failure degrades to a warning, never to exit 70", async () => {
  const dir = await makeTmp();
  // runsDir 指向一个**文件**：写侧车必然失败（ENOTDIR），模拟磁盘只读/目录被换掉。
  const runsAsFile = path.join(dir, "runs-is-a-file");
  await fsp.writeFile(runsAsFile, "not a directory", "utf8");
  const warnings = await writeRunArtifacts({
    config: {
      runsDir: runsAsFile,
      scenariosDir: dir,
      tools: "0.1.0",
      app: { kind: "local-web", entry: path.join(dir, "server.js") },
      adapter: { module: "@reality-check/adapter-local-web" },
    } as Parameters<typeof writeRunArtifacts>[0]["config"],
    runId: "rc-test-1",
    result: { runId: "rc-test-1", verdict: "failed", seed: 1 } as RunResult,
    scenarioPath: path.join(dir, "s.json"),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /结论已落盘/);
  assert.match(warnings[0]!, /侧车\/报告写入失败/);
});

test("a corrupt events.jsonl line becomes a warning, not a lost conclusion", async () => {
  const dir = await makeTmp();
  await fsp.writeFile(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify({ kind: "run-started" })}\nnot json at all\n${JSON.stringify({ kind: "run-finished" })}\n`,
    "utf8",
  );
  const { events, warnings } = await readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /1 行无法解析/);
});

test("RunOutcome carries warnings so commands can surface them on stderr", async () => {
  const outcome: RunOutcome = {
    result: { runId: "r", verdict: "passed" } as RunResult,
    scenario: {} as RunOutcome["scenario"],
    runDir: "d",
    warnings: ["w"],
  };
  assert.deepEqual(outcome.warnings, ["w"]);
});