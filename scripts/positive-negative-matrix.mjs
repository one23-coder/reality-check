#!/usr/bin/env node
/** 正反例配对矩阵 (方案 §0 审查方法 1 + 附录 A.1): 正确实现下不误报，故障实现下必报对。
 *
 * 每条用例 = 场景 × (正确版 | 故障开关)，判据是**退出码即契约**加上归因到的规则 id。
 * 两个独立应用都跑：booking-app（course-1）与 exam-seat-app（exam-1），后者用
 * `.reality-check.exam.json`（独立 runs-exam 数据根）。
 *
 * Usage: node scripts/positive-negative-matrix.mjs [--verbose]
 * Exit 0 = 全部用例的退出码与期望一致；1 = 有偏差（逐条打印）。
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/cli/dist/src/main.js");
const verbose = process.argv.includes("--verbose");

/** [名称, 参数, 期望退出码, 期望在输出中出现的规则/结论] */
const CASES = [
  // ---- check: 结构校验 + 适配器能力检查（不启动应用）
  ["check booking-normal", ["check", "scenarios/booking-normal.json"], 0],
  ["check booking-contend", ["check", "scenarios/booking-contend.json"], 0],
  ["check booking-cancel-waitlist", ["check", "scenarios/booking-cancel-waitlist.json"], 0],
  ["check booking-conditional-skip", ["check", "scenarios/booking-conditional-skip.json"], 0],
  ["check exam-normal", ["check", "scenarios/exam-normal.json", "--config", ".reality-check.exam.json"], 0],
  ["check exam-contend", ["check", "scenarios/exam-contend.json", "--config", ".reality-check.exam.json"], 0],
  [
    "check exam-cancel-waitlist",
    ["check", "scenarios/exam-cancel-waitlist.json", "--config", ".reality-check.exam.json"],
    0,
  ],
  // ---- booking-app 正确实现
  ["booking-normal (correct)", ["run", "scenarios/booking-normal.json"], 0],
  ["booking-contend (correct)", ["run", "scenarios/booking-contend.json"], 0],
  ["booking-cancel-waitlist (correct)", ["run", "scenarios/booking-cancel-waitlist.json"], 0],
  // ---- 场景 1.1 条件步骤：条件不成立 ⇒ skipped（既非失败也非通过），判定不变
  [
    "booking-conditional-skip (when false -> skipped)",
    ["run", "scenarios/booking-conditional-skip.json"],
    0,
    ["held booking-recorded", "held capacity-not-exceeded"],
  ],
  // ---- booking-app 故障开关：必须归因到对应规则
  [
    "booking-contend + overbooking",
    ["run", "scenarios/booking-contend.json", "--fault", "overbooking"],
    1,
    ["violated capacity-not-exceeded"],
  ],
  [
    "booking-cancel-waitlist + cancel-keeps-slot",
    ["run", "scenarios/booking-cancel-waitlist.json", "--fault", "cancel-keeps-slot"],
    2,
    ["violated cancel-releases-slot", "violated waitlist-declared-order"],
  ],
  [
    "booking-cancel-waitlist + waitlist-order-wrong",
    ["run", "scenarios/booking-cancel-waitlist.json", "--fault", "waitlist-order-wrong"],
    1,
    ["violated waitlist-declared-order"],
  ],
  // ---- exam-seat-app 正确实现
  ["exam-normal (correct)", ["run", "scenarios/exam-normal.json", "--config", ".reality-check.exam.json"], 0],
  ["exam-contend (correct)", ["run", "scenarios/exam-contend.json", "--config", ".reality-check.exam.json"], 0],
  [
    "exam-cancel-waitlist (correct)",
    ["run", "scenarios/exam-cancel-waitlist.json", "--config", ".reality-check.exam.json"],
    0,
  ],
  // ---- exam-seat-app 故障开关
  [
    "exam-contend + overbooking",
    ["run", "scenarios/exam-contend.json", "--config", ".reality-check.exam.json", "--fault", "overbooking"],
    1,
    ["violated capacity-not-exceeded"],
  ],
  [
    "exam-cancel-waitlist + cancel-keeps-seat",
    [
      "run",
      "scenarios/exam-cancel-waitlist.json",
      "--config",
      ".reality-check.exam.json",
      "--fault",
      "cancel-keeps-seat",
    ],
    2,
    ["violated cancel-releases-seat", "violated waitlist-declared-order"],
  ],
  [
    "exam-cancel-waitlist + waitlist-order-wrong",
    [
      "run",
      "scenarios/exam-cancel-waitlist.json",
      "--config",
      ".reality-check.exam.json",
      "--fault",
      "waitlist-order-wrong",
    ],
    1,
    ["violated waitlist-declared-order"],
  ],
];

const failures = [];
const runIds = new Map();

function run(name, args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env },
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const first = stdout.split("\n").find((l) => l.trim().length > 0) ?? `(stderr) ${stderr.trim().slice(0, 160)}`;
  const idMatch = /^(?:run|check|rerun)\s+([^\s:]+)/.exec(first);
  if (idMatch?.[1] !== undefined) runIds.set(name, idMatch[1]);
  return { code: r.status, stdout, stderr, first };
}

console.log(`positive/negative matrix — ${CASES.length} cases (exit code is the contract)\n`);
for (const [name, args, expected, mustContain = []] of CASES) {
  const { code, stdout, first } = run(name, args);
  const missing = mustContain.filter((needle) => !stdout.includes(needle));
  const ok = code === expected && missing.length === 0;
  if (!ok) failures.push({ name, expected, code, missing, first });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} exit=${String(code).padStart(2)} (want ${expected})  ${first}`,
  );
  if (missing.length > 0) console.log(`      missing in output: ${missing.join(" | ")}`);
  if (verbose && !ok) console.log(stdout);
}

// ---- rerun: 同种子重建环境复跑，结论必须与首轮一致（方案 §5 用户路径 5）
const prevId = runIds.get("booking-normal (correct)");
if (prevId !== undefined) {
  const { code, first } = run("rerun", ["rerun", "--run-id", prevId]);
  const ok = code === 0 && first.includes("previous=passed now=passed");
  if (!ok) failures.push({ name: `rerun ${prevId}`, expected: 0, code, missing: [], first });
  console.log(`${ok ? "PASS" : "FAIL"}  ${"rerun booking-normal".padEnd(46)} exit=${String(code).padStart(2)} (want 0)  ${first}`);
}

console.log(
  `\nmatrix: ${CASES.length + 1} cases, ${failures.length} deviation(s)` +
    (failures.length === 0 ? " — 正确实现全部通过，故障实现全部归因" : ""),
);
process.exit(failures.length === 0 ? 0 : 1);
