#!/usr/bin/env node
/** 一键验收门禁（方案 §12 的「完美」清单落到一条命令）。
 *
 * 顺序即依赖顺序：先绿色门禁（类型/构建/单测），再端到端证据链
 * （正反例矩阵 → 标注案例集基准 → 三入口一致性 → 外部助手闭环 → blocked → 串行稳定性）。
 * 任何一项失败即整体失败，且**不跳过**后续项（失败清单要一次看全）。
 *
 * Usage: node scripts/acceptance.mjs [--no-serial]
 *   --no-serial  跳过 10 次串行稳定性（最慢的一项，约 2 分钟）
 * Exit 0 = 全部通过；1 = 有失败项（逐条打印）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const skipSerial = process.argv.includes("--no-serial");

/** [名称, 命令, 参数, 说明] —— 顺序执行，判据只有退出码。 */
const GATES = [
  // 说明里不写用例数：数字会随场景增加而漂移，判据是退出码，不是文案。
  ["verify", "npm", ["run", "verify"], "typecheck + build + 全仓测试（含真实浏览器 e2e）"],
  ["matrix", "node", ["scripts/positive-negative-matrix.mjs"], "正反例矩阵：退出码与归因规则"],
  ["benchmark", "node", ["scripts/diagnostic-benchmark.mjs"], "标注案例集：漏报/误报统计"],
  ["tri-entry", "node", ["scripts/tri-entry-consistency.mjs"], "CLI / 工作台 / MCP 逐字段比对 result.json"],
  ["agent-loop", "node", ["scripts/external-agent-loop.mjs"], "仅公开接口的闭环：failed → 修应用 → rerun passed"],
  ["blocked", "node", ["scripts/blocked-case.mjs"], "环境缺失 → exit 3、verdict blocked、规则 not-evaluated"],
  ...(skipSerial
    ? []
    : [["serial", "node", ["scripts/serial-stability.mjs"], "固定场景连跑 10 次结论一致"]]),
];

console.log(`acceptance gates — ${GATES.length} 项，任一失败即整体失败\n`);
const rows = [];
for (const [name, cmd, args, note] of GATES) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 900_000,
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = r.status === 0;
  rows.push({ name, ok, seconds, status: r.status, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(11)} ${seconds.padStart(6)}s  ${note}`);
  if (!ok) {
    const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n  ");
    console.log(`      exit=${String(r.status)}\n  ${tail}`);
  }
}

const failed = rows.filter((r) => !r.ok);
console.log(
  `\nacceptance: ${rows.length - failed.length}/${rows.length} 通过` +
    (failed.length === 0 ? " — 全部证据链一致" : ` — 失败项：${failed.map((f) => f.name).join(", ")}`),
);
process.exit(failed.length === 0 ? 0 : 1);
