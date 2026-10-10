#!/usr/bin/env node
/** 外部助手闭环（方案 §7 怎么审查：让一个**未参与开发的**编程助手仅靠公开接口
 * 完成「读取失败 → 修改应用 → 复验」）。
 *
 * 本脚本扮演那个助手，并且**只用公开接口**：
 *   - MCP stdio 的 rc_run / rc_get_result / rc_rerun；
 *   - 对一个应用副本做普通文本编辑（任何编辑器都能做的替换）；
 *   - 不改内核、不 import @rc/core、不读运行目录的内部结构（只读 rc_get_result 的返回）。
 *
 * 闭环设计：配置里把故障开关**一直开着**（app.faultEnv=overbooking），失败来自应用
 * 代码；助手读到失败后修应用副本的那一行，再 rc_rerun 同一 runId —— 故障开关没变，
 * 结论由 failed 变成 passed，证明「修的是应用，不是测试」。
 *
 * Usage: node scripts/external-agent-loop.mjs
 * Exit 0 = 闭环成立（failed → 修应用 → rerun passed）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir, shutdown } from "./lib/child-cleanup.mjs";

const root = path.resolve(import.meta.dirname, "..");
const MCP_MAIN = path.join(root, "packages/mcp-server/dist/src/main.js");
const RUN_TIMEOUT_MS = 180_000;

const project = mkdtempSync(path.join(os.tmpdir(), "rc-agent-loop-"));
const scenariosDir = path.join(project, "scenarios");
const appDir = path.join(project, "app");
await fsp.mkdir(scenariosDir, { recursive: true });
await fsp.mkdir(appDir, { recursive: true });
const appCopy = path.join(appDir, "server.js");
await fsp.copyFile(path.join(root, "fixtures/booking-app/server.js"), appCopy);
await fsp.copyFile(
  path.join(root, "scenarios/booking-contend.json"),
  path.join(scenariosDir, "booking-contend.json"),
);
await fsp.writeFile(
  path.join(project, ".reality-check.json"),
  JSON.stringify({
    tools: "0.1.0",
    // The fault switch stays ON for the whole session: the only thing that
    // changes between the failing run and the passing rerun is the app code.
    app: { kind: "local-web", entry: appCopy, faultEnv: "overbooking" },
    adapter: { module: "@rc/adapter-local-web" },
    runsDir: "runs",
    scenariosDir: "scenarios",
  }),
  "utf8",
);

// ------------------------------------------------------------------ MCP client
const child = spawn(process.execPath, [MCP_MAIN], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
function payloadOf(response) {
  if (response.result?.isError === true) {
    throw new Error(`tool reported isError: ${JSON.stringify(response)}`);
  }
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`no text payload: ${JSON.stringify(response)}`);
  return JSON.parse(text);
}

let closed = false;
try {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  notify("notifications/initialized");

  // ---- step 1: run the app as-is -> it must FAIL on the business rule
  const failed = payloadOf(
    await request("tools/call", {
      name: "rc_run",
      arguments: { scenarioPath: "scenarios/booking-contend.json" },
    }),
  );
  console.log(`1. rc_run            ${failed.runId}: verdict=${failed.verdict} exit=${failed.exitCode}`);
  if (failed.verdict !== "failed" || failed.exitCode !== 1) {
    throw new Error(`expected a failed business verdict, got ${JSON.stringify(failed).slice(0, 300)}`);
  }

  // ---- step 2: read the failure through the public result interface
  const detail = payloadOf(
    await request("tools/call", { name: "rc_get_result", arguments: { runId: failed.runId } }),
  );
  const violated = detail.result.ruleEvaluations
    .filter((e) => e.verdict === "violated")
    .map((e) => `${e.ruleId}(${e.assertionId} observed=${String(e.observed)} expected=${e.expected})`);
  console.log(`2. rc_get_result     violated: ${violated.join(", ") || "(none)"}`);
  if (violated.length === 0) throw new Error("no violated rule reported; nothing to fix");

  // ---- step 3: fix the APPLICATION (plain text edit on the app copy)
  const before = await fsp.readFile(appCopy, "utf8");
  const bypass = 'if (FAULT !== "overbooking" && booked >= course.capacity) {';
  if (!before.includes(bypass)) throw new Error("app copy no longer contains the expected fault branch");
  const after = before.replace(bypass, "if (booked >= course.capacity) {");
  await fsp.writeFile(appCopy, after, "utf8");
  console.log(`3. edit app          removed the overbooking bypass (${before.length} -> ${after.length} bytes)`);

  // ---- step 4: re-verify the SAME run (fault switch still on)
  const rerun = payloadOf(
    await request("tools/call", { name: "rc_rerun", arguments: { runId: failed.runId } }),
  );
  console.log(
    `4. rc_rerun          ${rerun.runId}: verdict=${rerun.verdict} exit=${rerun.exitCode} ` +
      `(prev ${String(rerun.previousRunId ?? failed.runId)} = ${String(rerun.previousVerdict ?? "failed")})`,
  );
  closed = rerun.verdict === "passed" && rerun.exitCode === 0;
  if (!closed) throw new Error(`rerun did not pass: ${JSON.stringify(rerun).slice(0, 300)}`);

  console.log(
    "\nexternal-agent-loop: OK — 仅用 MCP 公开接口 + 一次应用文本编辑，完成 failed → 修应用 → rerun passed",
  );
} catch (e) {
  console.log(`\nexternal-agent-loop: FAILED — ${e instanceof Error ? e.message : String(e)}`);
} finally {
  child.stdin.end();
  // Teardown must never turn a successful loop into a failed exit code.
  await shutdown(child);
  if (!(await removeTempDir(project))) {
    console.log(`note: temp dir left behind (still locked by the OS): ${project}`);
  }
}
process.exit(closed ? 0 : 1);
