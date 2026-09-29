#!/usr/bin/env node
/** 阶段1收尾任务1：blocked 路径（退出码 3）专门验收。
 * 方案 §5: "人为制造环境缺失，观察 run 的退出码 3 与结论行；
 * 环境问题被明确标为 blocked，不冒充业务缺陷也不假装通过。"
 *
 * 制造方式：config 指向不存在的应用入口 → setupEnv 必然失败 →
 * 内核必须产出 verdict=blocked、退出码 3、规则全部 not-evaluated。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/cli/dist/src/main.js");
const work = join(root, ".blocked-case");
rmSync(work, { recursive: true, force: true });
mkdirSync(work);

const config = {
  tools: "0.1.0",
  app: { kind: "local-web", entry: "fixtures/does-not-exist/server.js" },
  adapter: { module: "@rc/adapter-local-web" },
  runsDir: join(work, "runs"),
  scenariosDir: "scenarios",
};
const configPath = join(work, "config.json");
writeFileSync(configPath, JSON.stringify(config));

const r = spawnSync(
  process.execPath,
  [cli, "run", "scenarios/booking-normal.json", "--config", configPath],
  { cwd: root, encoding: "utf8", timeout: 120000 },
);

const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
console.log(out.trim().split("\n").slice(-6).join("\n"));
console.log(`\nblocked-case: exit=${r.status}`);

let resultFile;
try {
  const runsDir = join(work, "runs");
  const runId = readdirSync(runsDir)[0];
  resultFile = JSON.parse(readFileSync(join(runsDir, runId, "result.json"), "utf8"));
} catch {
  resultFile = undefined;
}

const checks = [
  ["exit code is 3", r.status === 3],
  ["verdict is blocked", resultFile?.verdict === "blocked"],
  [
    "all rules not-evaluated",
    Array.isArray(resultFile?.ruleEvaluations) &&
      resultFile.ruleEvaluations.length > 0 &&
      resultFile.ruleEvaluations.every((e) => e.verdict === "not-evaluated"),
  ],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "OK" : "FAIL"} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? "blocked-case: PASS" : "blocked-case: FAIL");
rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
