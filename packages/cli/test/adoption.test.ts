/** 第三个应用的**接入演练**（真实浏览器端到端）。
 *
 * 这是"接入新应用 = 写配置，不改适配器源码"这条产品主张的证据。charging-app 与两个
 * 自带参考应用**不同域、不同 schema、不同观察器命名**：
 *   · 表：stations / reservations / queue（没有 courses / bookings / exams）
 *   · 口径：ports-free / reservation-count / holder-account
 * 配置里**不指定** adapter.observers —— 口径必须来自应用目录旁的
 * reality-check.observers.json（否则场景引用的观察器根本不存在）。
 *
 * 反证同样重要：把场景的观察器换成自带参考应用的 booking-count（只在 fixture 预设里
 * 存在的 id），必须 exit 64 被拒——证明内核没有偷偷回退到预设口径。
 */
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { checkCommand } from "../src/commands/check.js";
import { runCommand } from "../src/commands/run.js";
import { toCommandResult, type CommandResult } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const APP_ENTRY = path.join(ROOT, "fixtures", "charging-app", "server.js");
const APP_OBSERVERS = path.join(ROOT, "fixtures", "charging-app", "reality-check.observers.json");
const SCENARIO = path.join(ROOT, "scenarios", "charging-normal.json");
const OVERBOOK_SCENARIO = path.join(ROOT, "scenarios", "charging-overbook.json");

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makeTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-adoption-"));
  tmpDirs.push(dir);
  return dir;
}

/** 一个"第三方项目"的配置：只给应用入口，**不**声明观察器。 */
async function writeConfig(dir: string, entry: string, faultEnv?: string): Promise<string> {
  const file = path.join(dir, ".reality-check.json");
  await fsp.writeFile(
    file,
    JSON.stringify(
      {
        tools: "0.1.0",
        app: { kind: "local-web", entry, ...(faultEnv !== undefined ? { faultEnv } : {}) },
        adapter: { module: "@rc/adapter-local-web" },
        runsDir: path.join(dir, "runs"),
        scenariosDir: path.join(ROOT, "scenarios"),
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

async function run(
  fn: (args: string[]) => Promise<CommandResult>,
  args: string[],
): Promise<CommandResult> {
  try {
    return await fn(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

describe("第三个应用接入（只写配置，不改适配器源码）", () => {
  it("check 通过：场景的观察器口径由应用自己声明", async () => {
    const dir = await makeTmp();
    const cfg = await writeConfig(dir, APP_ENTRY);
    const res = await run(checkCommand, [SCENARIO, "--config", cfg]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /check: OK scenario=charging-normal/);
  });

  it("run 通过：充电桩应用跑出 passed，用的是它自己的表与口径", { timeout: 180000 }, async () => {
    const dir = await makeTmp();
    const cfg = await writeConfig(dir, APP_ENTRY);
    const res = await run(runCommand, [SCENARIO, "--config", cfg]);
    assert.equal(res.code, 0, `${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout.split("\n")[0] ?? "", /^run rc-\S+: passed \(exit 0\)$/);

    // 观察器确实来自应用自己的声明：ports-free / holder-account 只存在于这个应用。
    const runId = (res.stdout.split("\n")[0] ?? "").split(" ")[1]?.replace(/:$/, "") ?? "";
    const result = JSON.parse(
      await fsp.readFile(path.join(dir, "runs", runId, "result.json"), "utf8"),
    ) as { verdict: string; attempts: { stepId: string; outcome: string }[] };
    assert.equal(result.verdict, "passed");
    assert.deepEqual(
      result.attempts.map((a) => a.stepId),
      ["alice-register", "alice-login", "alice-nav-reserve", "alice-submit-reserve"],
    );
    const events = await fsp.readFile(path.join(dir, "runs", runId, "events.jsonl"), "utf8");
    for (const id of ["ports-free", "reservation-count", "holder-account"]) {
      assert.ok(events.includes(`"observerId":"${id}"`), `observation of ${id} must be recorded`);
    }
  });

  it("同一个应用开故障开关 ⇒ 被这套新口径判失败（exit 1）", { timeout: 180000 }, async () => {
    const dir = await makeTmp();
    // "能跑通"本身不构成证据：新应用的错误实现必须被它的新口径抓住。
    // 满位场景（两个 holder 占满 2 个桩口）+ RC_FAULT=overbooking ⇒ 超发 1 个桩口。
    const cfg = await writeConfig(dir, APP_ENTRY, "overbooking");
    const res = await run(runCommand, [OVERBOOK_SCENARIO, "--config", cfg]);
    assert.equal(res.code, 1, `${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /failed/);
    // ports-free 会变成 -1：桩口守恒这条业务规则被证伪。
    assert.match(res.stdout, /ports-not-exceeded/);
  });

  it("同一个满位场景在正确实现下通过（正反例配对）", { timeout: 180000 }, async () => {
    const dir = await makeTmp();
    const cfg = await writeConfig(dir, APP_ENTRY);
    const res = await run(runCommand, [OVERBOOK_SCENARIO, "--config", cfg]);
    // 正确实现把 alice 排进队列：reservations 仍是 2、空闲为 0 ⇒ passed(exit 0)。
    assert.equal(res.code, 0, `${res.stderr}\n${res.stdout}`);
  });

  it("不指定观察器的第三方应用不会静默拿到自带参考应用的口径（exit 64）", async () => {
    const dir = await makeTmp();
    // "第三方应用"：入口存在、旁边没有 reality-check.observers.json。
    const appDir = path.join(dir, "app");
    await fsp.mkdir(appDir, { recursive: true });
    const entry = path.join(appDir, "server.js");
    await fsp.copyFile(APP_ENTRY, entry);
    // 应用是同一个，但**没有**把口径声明带过去。
    await fsp.copyFile(APP_OBSERVERS, path.join(appDir, "other-name.json"));
    const cfg = await writeConfig(dir, entry);
    const res = await run(checkCommand, [SCENARIO, "--config", cfg]);
    assert.equal(res.code, 64);
    assert.match(res.stderr, /no observers declared for app/);
  });

  it("场景引用自带参考应用的观察器 ⇒ 被拒（证明没有偷偷回退到预设）", async () => {
    const dir = await makeTmp();
    const raw = JSON.parse(await fsp.readFile(SCENARIO, "utf8")) as {
      observers: unknown;
      assertions: unknown;
    };
    // booking-count 只存在于自带参考应用的**预设**里：如果内核偷偷回退到预设，
    // 这份场景就会被放行（甚至"跑通"）。它必须被拒。
    raw.observers = [
      {
        id: "booking-count",
        sql: "SELECT COUNT(*) AS n FROM bookings",
        tables: ["bookings"],
        expectColumns: ["n"],
      },
    ];
    raw.assertions = [
      { id: "a1", rule: "reservation-recorded", observer: "booking-count", op: "eq", value: 2 },
    ];
    const bad = path.join(dir, "bad.json");
    await fsp.writeFile(bad, JSON.stringify(raw, null, 2), "utf8");
    const cfg = await writeConfig(dir, APP_ENTRY);
    const res = await run(checkCommand, [bad, "--config", cfg]);
    assert.equal(res.code, 64);
    assert.match(res.stderr, /booking-count/);
  });
});