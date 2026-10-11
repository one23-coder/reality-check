/** 跨入口配置判定（方案 §7「三入口一致」）。
 *
 * 这一份判定必须只有一份实现：CLI 曾拒绝 `tools` 版本不符与未知
 * `adapter.module`（exit 64），MCP 侧却整段忽略——同一份配置在两个入口得到
 * 两种判决，而"三入口一致"是写进方案的承诺。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_MODULES, TOOLS_VERSION, checkToolsConfig } from "../src/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI_MAIN = path.join(REPO_ROOT, "packages/cli/dist/src/main.js");
const MCP_MAIN = path.join(REPO_ROOT, "packages/mcp-server/dist/src/main.js");

test("checkToolsConfig: accepts a well-formed config, names every violation", () => {
  assert.deepEqual(checkToolsConfig({ tools: TOOLS_VERSION }, "f"), []);
  assert.deepEqual(checkToolsConfig({ tools: TOOLS_VERSION, adapter: { module: ADAPTER_MODULES[1] } }, "f"), []);
  assert.match(checkToolsConfig({ tools: "9.9.9" }, "f")[0]!, /tools version must be/);
  assert.match(checkToolsConfig({ adapter: { module: "evil/adapter" } }, "f")[0]!, /adapter\.module must be one of/);
  // 文件存在时 tools 是必填：CLI 的 schema 如此要求，MCP 不能默默容忍
  assert.match(checkToolsConfig({}, "f", { requireTools: true })[0]!, /"tools" is required/);
  assert.deepEqual(checkToolsConfig({}, "f"), []);
  assert.match(checkToolsConfig([], "f")[0]!, /expected a JSON object/);
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnProcess(file: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

/** 同一份配置喂给两个真实入口：CLI 必须 exit 64，MCP 必须拒绝启动（也是 64）。 */
async function bothEntrancesReject(body: unknown): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "rc-tools-config-"));
  try {
    await writeFile(path.join(dir, ".reality-check.json"), JSON.stringify(body), "utf8");
    const cli = await spawnProcess(CLI_MAIN, ["export"], dir);
    assert.equal(cli.code, 64, `CLI must reject; stderr=${cli.stderr}`);
    const mcp = await spawnProcess(MCP_MAIN, [], dir);
    assert.equal(mcp.code, 64, `MCP must reject the same file; stderr=${mcp.stderr}`);
    // MCP 的 stdout 是协议流：拒绝信息只能出现在 stderr
    assert.equal(mcp.stdout.trim(), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a wrong tools version is rejected identically by the CLI and the MCP server", async () => {
  await bothEntrancesReject({
    tools: "9.9.9",
    app: { kind: "local-web", entry: "./server.js" },
    adapter: { module: "@rc/adapter-local-web" },
    runsDir: "runs",
    scenariosDir: "scenarios",
  });
});

test("an unknown adapter.module is rejected identically by the CLI and the MCP server", async () => {
  await bothEntrancesReject({
    tools: TOOLS_VERSION,
    app: { kind: "local-web", entry: "./server.js" },
    adapter: { module: "evil/adapter" },
    runsDir: "runs",
    scenariosDir: "scenarios",
  });
});