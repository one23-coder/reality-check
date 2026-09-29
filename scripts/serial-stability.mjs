#!/usr/bin/env node
/** 阶段1收尾任务2：串行稳定性 —— 固定数据场景连续 10 次运行，结论必须一致。
 * 方案 §5: "固定数据场景连跑 10 次；10/10 结论一致；不一致必须归因并记录。"
 * Usage: node scripts/serial-stability.mjs [scenario] [runs]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const scenario = process.argv[2] ?? "scenarios/booking-normal.json";
const runs = Number(process.argv[3] ?? 10);
const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/cli/dist/src/main.js");
const runsDir = join(root, "runs-stability");

rmSync(runsDir, { recursive: true, force: true });
mkdirSync(join(root, ".stability"), { recursive: true });
const config = {
  tools: "0.1.0",
  app: { kind: "local-web", entry: "fixtures/booking-app/server.js" },
  adapter: { module: "@rc/adapter-local-web" },
  runsDir: "runs-stability",
  scenariosDir: "scenarios",
};
const { writeFileSync } = await import("node:fs");
const configPath = join(root, ".stability/config.json");
writeFileSync(configPath, JSON.stringify(config));

const results = [];
for (let i = 1; i <= runs; i++) {
  const r = spawnSync(process.execPath, [cli, "run", scenario, "--config", configPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
  });
  const conclusion = (r.stdout ?? "").split("\n").find((l) => l.startsWith("run "));
  results.push({ i, exit: r.status, conclusion: conclusion ?? `(stderr) ${(r.stderr ?? "").trim().slice(0, 120)}` });
  console.log(`run ${i}: exit=${r.status} ${results[i - 1].conclusion}`);
}

const verdicts = new Set(results.map((r) => r.exit));
console.log(`\nserial-stability: ${results.length} runs, exit codes = [${[...verdicts].join(",")}]`);
if (verdicts.size !== 1) {
  console.log("serial-stability: INCONSISTENT — each divergent run must be attributed (env/timing) and recorded");
  process.exit(1);
}
console.log("serial-stability: OK — 10/10 identical verdicts");
rmSync(runsDir, { recursive: true, force: true });
rmSync(join(root, ".stability"), { recursive: true, force: true });
