/** Scenario + run-record store: plain fs reads over the shared on-disk
 * layouts (scenariosDir/*.json; runsDir/<runId>/{run.json,result.json,
 * events.jsonl,report.html}). No re-implementation of execution — see
 * server.ts for the kernel calls (方案 §6: 复用同一执行内核与结果协议).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { validateScenario, type Scenario, type TimelineEvent } from "@rc/protocol";

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  rules: number;
  /** Present when the file could not be parsed/validated. */
  error?: string;
}

export interface RunSummary {
  runId: string;
  scenarioId: string;
  verdict: string;
  startedAt: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function loadScenarioFile(file: string): Promise<Scenario> {
  const text = await fsp.readFile(file, "utf8");
  return validateScenario(JSON.parse(text));
}

/** List scenariosDir entries (id, name, description, rules count). */
export async function listScenarios(scenariosDir: string): Promise<ScenarioSummary[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(scenariosDir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: ScenarioSummary[] = [];
  for (const name of names) {
    const file = path.join(scenariosDir, name);
    try {
      const s = await loadScenarioFile(file);
      out.push({ id: s.id, name: s.name, description: s.description, rules: s.rules.length });
    } catch (e) {
      out.push({
        id: name.replace(/\.json$/, ""),
        name: name,
        description: "",
        rules: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/** Load one scenario by id (id is used as <id>.json; path traversal is a
 * config-level rejection here, and the HTTP layer turns it into 400). */
export async function loadScenarioById(scenariosDir: string, id: string): Promise<Scenario> {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes(".."))
    throw new Error(`invalid scenario id "${id}"`);
  return loadScenarioFile(path.join(scenariosDir, `${id}.json`));
}

/** List all runs (runId, scenarioId, verdict, startedAt), sorted by
 * startedAt descending. Dirs without a result.json are skipped (they are
 * not finished runs). */
export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(runsDir);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const runId of entries) {
    const file = path.join(runsDir, runId, "result.json");
    try {
      const value: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!isPlainObject(value)) continue;
      const startedAt = value["startedAt"];
      out.push({
        runId: typeof value["runId"] === "string" ? value["runId"] : runId,
        scenarioId: typeof value["scenarioId"] === "string" ? value["scenarioId"] : "unknown",
        verdict: typeof value["verdict"] === "string" ? value["verdict"] : "unknown",
        startedAt: typeof startedAt === "string" ? startedAt : "",
      });
    } catch {
      // no result.json -> not a finished run
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
}

export interface RunDetail {
  result: Record<string, unknown>;
  events: TimelineEvent[];
  htmlPath: string;
}

function parseEvents(text: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    events.push(JSON.parse(line) as TimelineEvent);
  }
  return events;
}

/** Full run detail: result.json + events.jsonl + the on-disk report path. */
export async function readRunDetail(runsDir: string, runId: string): Promise<RunDetail | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..")) return undefined;
  const runDir = path.join(runsDir, runId);
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(await fsp.readFile(path.join(runDir, "result.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  let events: TimelineEvent[] = [];
  try {
    events = parseEvents(await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8"));
  } catch {
    // a run without events.jsonl still shows its result
  }
  return { result, events, htmlPath: path.join(runDir, "report.html") };
}
