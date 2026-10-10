#!/usr/bin/env node
/** 三入口一致性 (方案 §7 怎么审查: 同一配置经 CLI / 工作台 / MCP 运行，规则与结果语义一致
 * —— 用差异脚本逐字段比对 result.json)。
 *
 * 三个入口各自是**真实进程**：CLI 直接 run，工作台走 HTTP /api/run，MCP 走 stdio
 * JSON-RPC tools/call rc_run。三者跑同一场景（booking-normal）、同一 fixture 应用，
 * 只有 runId / 时间戳 / 端口 / 绝对路径允许不同；其余字段必须逐字一致。
 *
 * Usage: node scripts/tri-entry-consistency.mjs
 * Exit 0 = 三份 result.json 语义一致；1 = 存在差异（打印首个不同字段）。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CLI_MAIN = path.join(root, "packages/cli/dist/src/main.js");
const WB_MAIN = path.join(root, "packages/workbench/dist/src/main.js");
const MCP_MAIN = path.join(root, "packages/mcp-server/dist/src/main.js");
const APP = path.join(root, "fixtures/booking-app/server.js");
const SCENARIO_ID = "booking-normal";
const RUN_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const project = mkdtempSync(path.join(os.tmpdir(), "rc-tri-entry-"));
const scenariosDir = path.join(project, "scenarios");
const cliRuns = path.join(project, "runs");
const wbRuns = path.join(project, "wb-runs");

await fsp.mkdir(scenariosDir, { recursive: true });
await fsp.copyFile(
  path.join(root, "scenarios", `${SCENARIO_ID}.json`),
  path.join(scenariosDir, `${SCENARIO_ID}.json`),
);
// One config for CLI and MCP (both read cwd/.reality-check.json); the workbench
// gets the same inputs through flags. Absolute app entry: the cwd is a temp dir.
const config = {
  tools: "0.1.0",
  app: { kind: "local-web", entry: APP },
  adapter: { module: "@rc/adapter-local-web" },
  runsDir: "runs",
  scenariosDir: "scenarios",
};
await fsp.writeFile(path.join(project, ".reality-check.json"), JSON.stringify(config), "utf8");

const results = {};

// ---------------------------------------------------------------- entry 1: CLI
{
  const r = spawnSync(process.execPath, [CLI_MAIN, "run", `scenarios/${SCENARIO_ID}.json`], {
    cwd: project,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("run "));
  const m = /^run (\S+): (\w+) \(exit (\d+)\)/.exec(line ?? "");
  if (!m) throw new Error(`CLI entry produced no run line (exit=${r.status}): ${r.stderr ?? ""}`);
  results.cli = { runId: m[1], verdict: m[2], exitCode: Number(m[3]), runsDir: cliRuns };
  console.log(`CLI        run ${m[1]}: ${m[2]} (exit ${m[3]})`);
}

// ---------------------------------------------------------- entry 2: workbench
{
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [WB_MAIN, "--port", String(port), "--runs-dir", wbRuns, "--scenarios-dir", scenariosDir, "--app-path", APP],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const res = await fetch(`${base}/api/scenarios`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("workbench did not become ready within 30s");
      await sleep(200);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: SCENARIO_ID }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.json();
    if (!res.ok) throw new Error(`workbench /api/run -> HTTP ${res.status}: ${JSON.stringify(body)}`);
    results.workbench = {
      runId: body.runId,
      verdict: body.verdict,
      exitCode: body.exitCode,
      runsDir: wbRuns,
    };
    console.log(`workbench  run ${body.runId}: ${body.verdict} (exit ${body.exitCode})`);
  } finally {
    child.kill("SIGTERM");
  }
}

// ------------------------------------------------------------------ entry 3: MCP
{
  const child = spawn(process.execPath, [MCP_MAIN], {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  const request = (method, params) =>
    new Promise((resolve, reject) => {
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
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  try {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    notify("notifications/initialized");
    const run = await request("tools/call", {
      name: "rc_run",
      arguments: { scenarioPath: `scenarios/${SCENARIO_ID}.json` },
    });
    if (run.result?.isError === true) throw new Error(`MCP rc_run isError: ${JSON.stringify(run)}`);
    const text = run.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`MCP rc_run returned no text payload: ${JSON.stringify(run)}`);
    const payload = JSON.parse(text);
    results.mcp = {
      runId: payload.runId,
      verdict: payload.verdict,
      exitCode: payload.exitCode,
      runsDir: cliRuns,
    };
    console.log(`MCP        run ${payload.runId}: ${payload.verdict} (exit ${payload.exitCode})`);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

// ------------------------------------------------------- compare result.json
/** Everything that must be identical across entries. runId, timestamps, ports,
 * absolute db paths and evidence sha256 (DOM dumps embed the random base URL)
 * are deliberately excluded. */
function shape(r) {
  return {
    protocol: r.protocol,
    scenarioId: r.scenarioId,
    scenarioSha256: r.scenarioSha256,
    seed: r.seed,
    verdict: r.verdict,
    rules: r.ruleEvaluations.map((e) => ({
      ruleId: e.ruleId,
      assertionId: e.assertionId,
      verdict: e.verdict,
      observed: e.observed,
      expected: e.expected,
      gaps: e.missingEvidenceTypes ?? null,
    })),
    attempts: r.attempts.map((a) => ({
      stepId: a.stepId,
      actor: a.actor,
      op: a.op,
      outcome: a.outcome,
      evidence: (a.evidence ?? []).map((e) => `${e.kind}:${e.file}`),
    })),
    evidence: r.evidence.map((e) => `${e.kind}:${e.file}`),
    eventKinds: [...new Set(r.timeline.map((e) => e.kind))].sort(),
    env: {
      appVersion: r.env.appVersion,
      adapterVersion: r.env.adapterVersion,
      platform: r.env.platform,
    },
  };
}

const shapes = {};
for (const [entry, info] of Object.entries(results)) {
  const file = path.join(info.runsDir, info.runId, "result.json");
  shapes[entry] = shape(JSON.parse(await fsp.readFile(file, "utf8")));
  if (info.verdict !== shapes[entry].verdict) {
    throw new Error(`${entry}: CLI-reported verdict ${info.verdict} != result.json ${shapes[entry].verdict}`);
  }
}

const entries = Object.keys(shapes);
let identical = true;
for (const entry of entries.slice(1)) {
  const a = JSON.stringify(shapes[entries[0]], null, 2).split("\n");
  const b = JSON.stringify(shapes[entry], null, 2).split("\n");
  if (a.length !== b.length) {
    identical = false;
    console.log(`\nDIFF ${entries[0]} vs ${entry}: line count ${a.length} vs ${b.length}`);
    break;
  }
  let printed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      identical = false;
      if (printed++ < 10) console.log(`DIFF ${entries[0]}.${a[i]?.trim()}  vs  ${entry}.${b[i]?.trim()}`);
    }
  }
  if (!identical) break;
}

console.log(
  `\ntri-entry-consistency: ${entries.length} entries, verdicts=[${entries
    .map((e) => shapes[e].verdict)
    .join(",")}], evidence refs=${shapes[entries[0]].evidence.length}, attempts=${shapes[entries[0]].attempts.length}`,
);
console.log(
  identical
    ? "tri-entry-consistency: OK — CLI / workbench / MCP produce identical result semantics"
    : "tri-entry-consistency: MISMATCH — the three entries disagree on result semantics",
);

await fsp.rm(project, { recursive: true, force: true });
process.exit(identical ? 0 : 1);
