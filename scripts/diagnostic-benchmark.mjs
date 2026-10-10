#!/usr/bin/env node
/** 诊断能力基准（方案 §6 验收合格判定：用**预先标注**的正常/故障案例集评估，
 * 公开案例范围，不用自评代替）。
 *
 * 标签集 = fixtures/diagnostic-cases.json（在任何一次运行之前冻结，标签来自
 * fixture 的既定语义）。本脚本只负责比对与统计：不改标签、不挑案例、不重跑失败
 * 案例直到通过。三条判据缺一不可：
 *   1. 结论一致：退出码必须等于标签的 exitCode；
 *   2. 检出（漏报 FN）：标签 violatedRules 里的规则必须被报为 violated；
 *   3. 不牵连（误报 FP）：标签 cleanRules 里的规则**不得**被报为 violated。
 * 正确实现案例的 violatedRules 为空 —— 任何一次误报都会在第 3 条上显形。
 *
 * Usage: node scripts/diagnostic-benchmark.mjs [--case <id>]
 * Exit 0 = 全部案例与标签一致；1 = 有偏差（逐条公开漏报/误报）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const CLI = path.join(root, "packages/cli/dist/src/main.js");
const caseFlag = process.argv.indexOf("--case");
const only = caseFlag >= 0 ? process.argv[caseFlag + 1] : undefined;

const suite = JSON.parse(readFileSync(path.join(root, "fixtures/diagnostic-cases.json"), "utf8"));
const cases = only === undefined ? suite.cases : suite.cases.filter((c) => c.id === only);
if (cases.length === 0) {
  console.error(`no labeled case matches --case ${String(only)}`);
  process.exit(64);
}

/** ruleId -> set of verdicts, parsed from the CLI's `${verdict} ${ruleId}` lines. */
function ruleVerdicts(stdout) {
  const byRule = new Map();
  for (const raw of stdout.split("\n")) {
    const m = /^(held|violated|not-evaluated|inconclusive) (\S+)$/.exec(raw.trim());
    if (m === null) continue;
    const verdict = m[1];
    const ruleId = m[2];
    const seen = byRule.get(ruleId) ?? new Set();
    seen.add(verdict);
    byRule.set(ruleId, seen);
  }
  return byRule;
}

console.log(`diagnostic benchmark — ${cases.length} labeled case(s), labels frozen ${suite.frozenAt}`);
console.log(`scope: ${suite.scope[1]}`);
console.log(`       ${suite.scope[2]}\n`);

const rows = [];
for (const c of cases) {
  const config = c.app === "exam-seat-app" ? ".reality-check.exam.json" : ".reality-check.json";
  const args = ["run", c.scenario, "--config", config];
  if (c.fault !== null) args.push("--fault", c.fault);

  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
  });
  const stdout = r.stdout ?? "";
  const verdicts = ruleVerdicts(stdout);
  const violated = new Set(
    [...verdicts.entries()].filter(([, v]) => v.has("violated")).map(([rule]) => rule),
  );
  const fn = c.violatedRules.filter((rule) => !violated.has(rule));
  const fp = c.cleanRules.filter((rule) => violated.has(rule));
  const exitOk = r.status === c.exitCode;
  const runLine = (stdout.split("\n").find((l) => l.startsWith("run ")) ?? "(no run line)").trim();
  const ok = exitOk && fn.length === 0 && fp.length === 0;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.id.padEnd(46)} exit=${String(r.status)} (want ${c.exitCode})  ${runLine}`,
  );
  if (!exitOk) console.log(`      退出码偏差: got ${String(r.status)}, label ${c.exitCode}`);
  if (fn.length > 0) console.log(`      漏报 FN: ${fn.join(", ")}`);
  if (fp.length > 0) console.log(`      误报 FP: ${fp.join(", ")}`);
  rows.push({ id: c.id, exitOk, fn, fp });
}

const exitMismatch = rows.filter((x) => !x.exitOk).length;
const falseNegatives = rows.reduce((n, x) => n + x.fn.length, 0);
const falsePositives = rows.reduce((n, x) => n + x.fp.length, 0);
const perfect = rows.filter((x) => x.exitOk && x.fn.length === 0 && x.fp.length === 0).length;

console.log(
  `\nsummary: ${perfect}/${rows.length} 案例与标签完全一致 | 退出码偏差 ${exitMismatch} | 漏报 ${falseNegatives} | 误报 ${falsePositives}`,
);
console.log(
  `label scope: ${suite.scope.length} 条限制已公开于 fixtures/diagnostic-cases.json（不含线上应用/时序抖动/网络异常）。`,
);
if (falsePositives > 0) {
  console.log("误报样本（公开）：" + rows.filter((x) => x.fp.length > 0).map((x) => `${x.id}[${x.fp.join(",")}]`).join(" | "));
}
if (falseNegatives > 0) {
  console.log("漏报样本（公开）：" + rows.filter((x) => x.fn.length > 0).map((x) => `${x.id}[${x.fn.join(",")}]`).join(" | "));
}
console.log(
  perfect === rows.length
    ? "diagnostic-benchmark: OK — 与冻结标签逐条一致"
    : "diagnostic-benchmark: MISMATCH — 与冻结标签存在偏差（见上）",
);
process.exit(perfect === rows.length ? 0 : 1);
