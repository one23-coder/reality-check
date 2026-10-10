/** CLI unit tests (node:test, NO browsers — check must not spawn the app).
 * Covers: check 0/64, BOM'd config 64, export listing + rerun lines,
 * plan keyword selection / needs-model fallback / empty-scenarios 64,
 * and the process-level dispatch contract of main.js (--help, unknown). */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  parseArgs,
  toCommandResult,
  type CommandResult,
} from "../src/config.js";
import { checkCommand } from "../src/commands/check.js";
import { exportCommand } from "../src/commands/export.js";
import { planCommand } from "../src/commands/plan.js";
import { main, USAGE } from "../src/main.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCENARIOS_DIR = path.join(ROOT, "scenarios");
const MAIN_JS = path.join(ROOT, "packages", "cli", "dist", "src", "main.js");

const tmpDirs: string[] = [];
after(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-cli-test-"));
  tmpDirs.push(dir);
  return dir;
}

interface ConfigOverrides {
  runsDir?: string;
  scenariosDir?: string;
  entry?: string;
}

async function writeConfig(dir: string, overrides: ConfigOverrides = {}): Promise<string> {
  const cfg = {
    tools: "0.1.0",
    app: { kind: "local-web", entry: overrides.entry ?? "server.js" },
    adapter: { module: "@reality-check/adapter-local-web" },
    runsDir: overrides.runsDir ?? path.join(dir, "runs"),
    scenariosDir: overrides.scenariosDir ?? path.join(dir, "scenarios"),
  };
  const file = path.join(dir, ".reality-check.json");
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2), "utf8");
  return file;
}

/** Mirror main(): commands resolve to a CommandResult, never throw. */
async function runCmd(fn: (args: string[]) => Promise<CommandResult>, args: string[]): Promise<CommandResult> {
  try {
    return await fn(args);
  } catch (e) {
    return toCommandResult(e);
  }
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN_JS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

describe("parseArgs", () => {
  it("splits positionals, --flag value and --flag=value", () => {
    const parsed = parseArgs(["s.json", "--seed", "7", "--fault=overbooking", "--verbose"]);
    assert.deepEqual(parsed.positionals, ["s.json"]);
    assert.equal(parsed.flags.get("seed"), "7");
    assert.equal(parsed.flags.get("fault"), "overbooking");
    assert.equal(parsed.flags.get("verbose"), true);
  });
});

describe("check command", () => {
  it("valid scenario passes without spawning the app (dummy entry)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir, { entry: "does-not-exist.js" });
    const res = await runCmd(
      checkCommand,
      [path.join(SCENARIOS_DIR, "booking-normal.json"), "--config", config],
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^check: OK scenario=booking-normal app=booking-app /);
    assert.match(res.stdout, /observers=2 assertions=2$/);
  });

  it("barrier scenario passes the capability gate", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const res = await runCmd(
      checkCommand,
      [path.join(SCENARIOS_DIR, "booking-contend.json"), "--config", config],
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /scenario=booking-contend/);
  });

  it("invalid scenario (unknown observer ref) is a config error (64)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const raw = JSON.parse(
      fs.readFileSync(path.join(SCENARIOS_DIR, "booking-normal.json"), "utf8"),
    ) as { assertions: { observer: string }[] };
    raw.assertions[0]!.observer = "ghost-observer";
    const bad = path.join(dir, "bad.json");
    await fsp.writeFile(bad, JSON.stringify(raw, null, 2), "utf8");
    const res = await runCmd(checkCommand, [bad, "--config", config]);
    assert.equal(res.code, 64);
    assert.match(res.stderr, /ghost-observer/);
  });

  it("missing scenario file is a config error (64)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const res = await runCmd(checkCommand, [path.join(dir, "nope.json"), "--config", config]);
    assert.equal(res.code, 64);
  });

  it("BOM'd config file is rejected (64)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    await fsp.writeFile(config, "\uFEFF" + fs.readFileSync(config, "utf8"), "utf8");
    const res = await runCmd(
      checkCommand,
      [path.join(SCENARIOS_DIR, "booking-normal.json"), "--config", config],
    );
    assert.equal(res.code, 64);
    assert.match(res.stderr, /BOM/);
  });

  it("missing config file is a config error (64)", async () => {
    const dir = await makeTmp();
    const res = await runCmd(
      checkCommand,
      [path.join(SCENARIOS_DIR, "booking-normal.json"), "--config", path.join(dir, "absent.json")],
    );
    assert.equal(res.code, 64);
  });
});

describe("export command", () => {
  it("lists fabricated runs sorted by startedAt with rerun lines", async () => {
    const dir = await makeTmp();
    const runsDir = path.join(dir, "runs");
    const config = await writeConfig(dir, { runsDir });

    const mkRun = async (
      runId: string,
      startedAt: string,
      verdict: string,
    ): Promise<void> => {
      const runDir = path.join(runsDir, runId);
      await fsp.mkdir(runDir, { recursive: true });
      await fsp.writeFile(
        path.join(runDir, "run.json"),
        JSON.stringify({ runId, scenarioId: "booking-normal", seed: 7 }, null, 2),
        "utf8",
      );
      await fsp.writeFile(
        path.join(runDir, "result.json"),
        JSON.stringify(
          {
            protocol: { result: "1.0" },
            runId,
            scenarioId: "booking-normal",
            seed: 7,
            startedAt,
            verdict,
          },
          null,
          2,
        ),
        "utf8",
      );
      await fsp.writeFile(
        path.join(runDir, "cli.json"),
        JSON.stringify({ scenarioPath: path.join(SCENARIOS_DIR, "booking-normal.json"), seed: 7 }, null, 2),
        "utf8",
      );
    };
    // deliberately created out of startedAt order
    await mkRun("run-later", "2026-01-02T00:00:00.000Z", "failed");
    await mkRun("run-earlier", "2026-01-01T00:00:00.000Z", "passed");
    await fsp.mkdir(path.join(runsDir, "not-a-run"), { recursive: true }); // no result.json

    const res = await runCmd(exportCommand, ["--config", config]);
    assert.equal(res.code, 0, res.stderr);
    const earlier = res.stdout.indexOf("reality-check rerun --run-id run-earlier");
    const later = res.stdout.indexOf("reality-check rerun --run-id run-later");
    assert.ok(earlier >= 0 && later >= 0, res.stdout);
    assert.ok(earlier < later, "runs must be sorted by startedAt");
    assert.match(res.stdout, /run-earlier\tbooking-normal\tpassed\t/);
    assert.match(res.stdout, /run-later\tbooking-normal\tfailed\t/);
    assert.ok(!res.stdout.includes("not-a-run"));
  });

  it("--format json prints the array", async () => {
    const dir = await makeTmp();
    const runsDir = path.join(dir, "runs");
    const config = await writeConfig(dir, { runsDir });
    const runDir = path.join(runsDir, "run-1");
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.writeFile(
      path.join(runDir, "result.json"),
      JSON.stringify({
        protocol: { result: "1.0" },
        runId: "run-1",
        scenarioId: "booking-contend",
        startedAt: "2026-01-01T00:00:00.000Z",
        verdict: "inconclusive",
      }),
      "utf8",
    );
    const res = await runCmd(exportCommand, ["--format", "json", "--config", config]);
    assert.equal(res.code, 0, res.stderr);
    const runs: unknown = JSON.parse(res.stdout);
    assert.ok(Array.isArray(runs) && runs.length === 1);
    const first = (runs as { runId: string; verdict: string }[])[0]!;
    assert.equal(first.runId, "run-1");
    assert.equal(first.verdict, "inconclusive");
  });

  it("empty/absent runsDir exports an empty list, not an error", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const res = await runCmd(exportCommand, ["--config", config]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /no runs found/);
  });
});

describe("plan command", () => {
  it("争抢最后名额 picks booking-contend", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir, { scenariosDir: SCENARIOS_DIR });
    const res = await runCmd(planCommand, ["帮我测一下争抢最后名额", "--config", config]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /scenario=booking-contend/);
    assert.match(res.stdout, /needsModel=false/);
    assert.match(res.stdout, /fallback=heuristic/);
  });

  it("取消候补 picks booking-cancel-waitlist", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir, { scenariosDir: SCENARIOS_DIR });
    const res = await runCmd(planCommand, ["我想取消报名然后看候补递补", "--config", config]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /scenario=booking-cancel-waitlist/);
  });

  it("no category clue and no usable model -> NO scenario chosen, never a guessed default (exit 0)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir, { scenariosDir: SCENARIOS_DIR });
    const res = await runCmd(planCommand, ["随便测个登月流程", "--config", config]);
    assert.equal(res.code, 0, res.stderr);
    // Saved scenarios exist, but 规则 9 forbids guessing a default: the planner
    // says needsModel and picks nothing at all (no `scenario=` line).
    assert.match(res.stdout, /plan: no scenario chosen/);
    assert.match(res.stdout, /needsModel=true/);
    assert.match(res.stdout, /fallback=needs-model/);
    assert.match(res.stdout, /reason=.*refusing to guess a default scenario/);
    assert.doesNotMatch(res.stdout, /scenario=/);
  });

  it("no scenarios available at all -> config error (64)", async () => {
    const dir = await makeTmp();
    const scenariosDir = path.join(dir, "scenarios");
    await fsp.mkdir(scenariosDir, { recursive: true });
    const config = await writeConfig(dir, { scenariosDir });
    const res = await runCmd(planCommand, ["随便测个登月流程", "--config", config]);
    assert.equal(res.code, 64);
    assert.match(res.stderr, /no scenario available/);
  });

  it("missing request argument -> usage config error (64)", async () => {
    const dir = await makeTmp();
    const config = await writeConfig(dir);
    const res = await runCmd(planCommand, ["--config", config]);
    assert.equal(res.code, 64);
  });
});

describe("main dispatch (process level)", () => {
  it("--help exits 0 and prints the exit-code contract", async () => {
    const res = await spawnCli(["--help"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout.split("\n")[0] ?? "", /reality-check/);
    for (const line of ["check", "run", "rerun", "export", "plan", "help"]) {
      assert.ok(res.stdout.includes(line), `usage must mention ${line}`);
    }
    assert.ok(res.stdout.includes("0"), "exit-code contract present");
    assert.ok(res.stdout.includes("70"), "exit-code contract present");
    assert.equal(USAGE.split("\n")[0], res.stdout.split("\n")[0]);
  });

  it("help subcommand behaves like --help", async () => {
    const res = await spawnCli(["help"]);
    assert.equal(res.code, 0);
    assert.match(res.stdout.split("\n")[0] ?? "", /reality-check/);
  });

  it("unknown command prints usage to stderr and exits 64", async () => {
    const res = await spawnCli(["teleport"]);
    assert.equal(res.code, 64);
    assert.match(res.stderr.split("\n")[0] ?? "", /reality-check/);
    assert.equal(res.stdout, "");
  });

  it("missing command exits 64", async () => {
    const res = await spawnCli([]);
    assert.equal(res.code, 64);
  });
});
