/** Execution kernel (方案 §9: 隔离环境 + 执行内核 + 观察接口).
 *
 * Gates the scenario against protocol versions and adapter capabilities
 * BEFORE any run directory or environment exists (config errors, exit 64),
 * then drives setup -> accounts -> steps/barriers -> observations ->
 * assertions -> verdict -> teardown. Environment failures produce verdict
 * "blocked" (exit 3), never an exception; adapter step failures produce
 * Attempt outcome "error" and the run continues.
 */
import { createHash } from "node:crypto";
import { platform, arch } from "node:os";
import { join } from "node:path";
import {
  ARTIFACTS_VERSION,
  MANIFEST_VERSION,
  RESULT_VERSION,
  SCENARIO_VERSION,
  type Attempt,
  type EnvSummary,
  type EvidenceRef,
  type RuleEvaluation,
  type RunResult,
  type Scenario,
  type Step,
  type Verdict,
} from "@rc/protocol";
import type { LocalWebAdapterV1, ObserverReading, StepContext } from "./adapter.js";
import { evaluateAssertion, rollUpVerdict } from "./assert.js";
import { RunArtifacts } from "./artifacts.js";
import { configError, internalError } from "./errors.js";
import { newRunId } from "./ownership.js";

/** Deterministic JSON (sorted object keys) — the canonical form hashed into
 * scenarioSha256 so re-runs of the same scenario reproduce the digest. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function errorDetail(e: unknown): Record<string, unknown> {
  return { error: e instanceof Error ? e.message : String(e) };
}

export async function executeScenario(
  scenario: Scenario,
  adapter: LocalWebAdapterV1,
  opts: { runsRoot: string; seed?: number },
): Promise<RunResult> {
  const manifest = adapter.manifest();

  // (a) Version gate — before any run dir or environment is created.
  if (scenario.protocol.scenario !== SCENARIO_VERSION)
    throw configError(
      `scenario protocol ${String(scenario.protocol.scenario)} not supported (kernel serves ${SCENARIO_VERSION})`,
    );
  if (manifest.scenarioVersion !== SCENARIO_VERSION)
    throw configError(
      `adapter "${manifest.adapterId}" serves scenario ${manifest.scenarioVersion}, kernel serves ${SCENARIO_VERSION}`,
    );
  if (manifest.protocol.manifest !== MANIFEST_VERSION)
    throw configError(
      `adapter manifest protocol ${String(manifest.protocol.manifest)} not supported (kernel serves ${MANIFEST_VERSION})`,
    );

  // (b) Capability gate.
  for (const step of scenario.steps)
    if (!manifest.supportedOps.includes(step.op))
      throw configError(`adapter does not support step op "${step.op}" (step ${step.id})`);
  for (const a of scenario.assertions)
    if (!manifest.supportedAssertions.includes(a.op))
      throw configError(`adapter does not support assertion op "${a.op}" (assertion ${a.id})`);
  const scenarioObservers = new Map(scenario.observers.map((o) => [o.id, o]));
  for (const a of scenario.assertions) {
    if (!scenarioObservers.has(a.observer))
      throw configError(`assertion "${a.id}" references unknown observer "${a.observer}"`);
    if (manifest.observers[a.observer] === undefined)
      throw configError(
        `observer "${a.observer}" is not declared by adapter "${manifest.adapterId}"`,
      );
  }
  for (const o of scenario.observers)
    for (const table of o.tables)
      if (!manifest.observedTables.includes(table))
        throw configError(
          `observer "${o.id}" reads table "${table}" outside the adapter whitelist`,
        );
  if (scenario.steps.some((s) => s.barrier === true) && !manifest.barriers)
    throw configError(`scenario uses barrier steps but adapter "${manifest.adapterId}" cannot`);

  // (c) Run dir + start event.
  const seed = opts.seed ?? scenario.seed;
  const runId = newRunId();
  const scenarioSha256 = createHash("sha256").update(canonicalJson(scenario)).digest("hex");
  const platformSummary = `${platform()} ${arch()} node ${process.version}`;
  const artifacts = await RunArtifacts.create(opts.runsRoot, runId, {
    scenarioId: scenario.id,
    scenarioSha256,
    seed,
    versions: {
      scenario: SCENARIO_VERSION,
      result: RESULT_VERSION,
      artifacts: ARTIFACTS_VERSION,
      manifest: MANIFEST_VERSION,
      adapter: manifest.adapterVersion,
    },
    platform: platformSummary,
  });
  await artifacts.event("run-started", { scenarioId: scenario.id, seed, scenarioSha256 });

  const attempts: Attempt[] = [];
  const evidence: EvidenceRef[] = [];
  const evaluations: RuleEvaluation[] = [];

  const fallbackEnv = (): EnvSummary => ({
    appVersion: "unknown",
    adapterVersion: manifest.adapterVersion,
    baseUrl: "unknown",
    seed,
    platform: platformSummary,
  });

  const blockedResult = (reason: string): RunResult => ({
    protocol: { result: RESULT_VERSION },
    runId,
    scenarioId: scenario.id,
    scenarioSha256,
    seed,
    startedAt: artifacts.startedAt,
    finishedAt: new Date().toISOString(),
    verdict: "blocked",
    ruleEvaluations: scenario.assertions.map((a) => ({
      ruleId: a.rule,
      assertionId: a.id,
      verdict: "not-evaluated" as const,
      observed: null,
      expected: `${a.op} ${a.value}`,
      evidenceRefs: [],
    })),
    timeline: [...artifacts.events()],
    attempts: [...attempts],
    env: fallbackEnv(),
    evidence: [...evidence],
  });

  const ctx: StepContext = {
    runDir: artifacts.dir,
    seed,
    event: (kind, detail, actor, causation) => {
      const eventOpts: { actor?: string; causation?: number } = {};
      if (actor !== undefined) eventOpts.actor = actor;
      if (causation !== undefined) eventOpts.causation = causation;
      return artifacts.event(kind, detail, eventOpts).then((e) => e.seq);
    },
  };

  const errorAttempt = (step: Step, e: unknown): Attempt => {
    const attempt: Attempt = {
      stepId: step.id,
      actor: step.actor,
      op: step.op,
      outcome: "error",
      detail: errorDetail(e),
    };
    return attempt;
  };

  const run = async (): Promise<RunResult> => {
    // (d) Environment. Any failure here is "blocked", never an exception.
    let env: EnvSummary;
    try {
      env = await adapter.setupEnv({
        runDir: artifacts.dir,
        seed,
        dataRoot: join(artifacts.dir, "data"),
      });
    } catch (e) {
      await artifacts.event("blocked", { stage: "setupEnv", ...errorDetail(e) });
      return blockedResult("setupEnv failed");
    }
    await artifacts.event("env-ready", { ...env });

    // (e) Accounts.
    try {
      await adapter.registerAccounts(scenario.roles);
    } catch (e) {
      await artifacts.event("blocked", { stage: "registerAccounts", ...errorDetail(e) });
      return blockedResult("registerAccounts failed");
    }
    await artifacts.event("accounts-registered", { count: scenario.roles.length });

    // (f) Steps; consecutive barrier steps form ONE runBarrier group.
    const recordAttempt = async (attempt: Attempt): Promise<void> => {
      attempts.push(attempt);
      const detail: Record<string, unknown> = {
        stepId: attempt.stepId,
        op: attempt.op,
        outcome: attempt.outcome,
      };
      if (attempt.httpStatus !== undefined) detail.httpStatus = attempt.httpStatus;
      if (attempt.detail !== undefined) detail.detail = attempt.detail;
      await artifacts.event("step", detail, { actor: attempt.actor });
    };

    const steps = scenario.steps;
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      if (step === undefined) break; // unreachable; noUncheckedIndexedAccess
      if (step.barrier === true) {
        const group: Step[] = [];
        while (i < steps.length) {
          const s = steps[i];
          if (s === undefined || s.barrier !== true) break;
          group.push(s);
          i++;
        }
        try {
          const batch = await adapter.runBarrier(group, ctx);
          for (const attempt of batch) await recordAttempt(attempt);
        } catch (e) {
          for (const s of group) await recordAttempt(errorAttempt(s, e));
        }
      } else {
        let attempt: Attempt;
        try {
          attempt = await adapter.runStep(step, ctx);
        } catch (e) {
          attempt = errorAttempt(step, e);
        }
        await recordAttempt(attempt);
        i++;
      }
    }

    // (g) Observations.
    const readings = new Map<string, ObserverReading>();
    const observerSeq = new Map<string, number>();
    for (const observer of scenario.observers) {
      try {
        const reading = await adapter.observe(observer.id);
        readings.set(observer.id, reading);
        evidence.push(...reading.evidence);
        const ev = await artifacts.event("observe", {
          observerId: observer.id,
          rows: reading.rows.length,
          columns: reading.columns,
          evidence: reading.evidence.length,
        });
        observerSeq.set(observer.id, ev.seq);
      } catch (e) {
        const ev = await artifacts.event("observe-error", {
          observerId: observer.id,
          ...errorDetail(e),
        });
        observerSeq.set(observer.id, ev.seq);
      }
    }

    // (h) Assertions, causally bound to their observer's event.
    for (const assertion of scenario.assertions) {
      const evaluation = evaluateAssertion(assertion, readings);
      evaluations.push(evaluation);
      const detail: Record<string, unknown> = {
        assertionId: assertion.id,
        ruleId: assertion.rule,
        verdict: evaluation.verdict,
        observed: evaluation.observed,
        expected: evaluation.expected,
      };
      if (evaluation.missingEvidenceTypes !== undefined)
        detail.missingEvidenceTypes = evaluation.missingEvidenceTypes;
      const eventOpts: { actor?: string; causation?: number } = {};
      const causation = observerSeq.get(assertion.observer);
      if (causation !== undefined) eventOpts.causation = causation;
      await artifacts.event("assert", detail, eventOpts);
    }

    // (i) Verdict.
    const verdict: Verdict = rollUpVerdict(evaluations);
    await artifacts.event("verdict", { verdict });

    return {
      protocol: { result: RESULT_VERSION },
      runId,
      scenarioId: scenario.id,
      scenarioSha256,
      seed,
      startedAt: artifacts.startedAt,
      finishedAt: new Date().toISOString(),
      verdict,
      ruleEvaluations: [...evaluations],
      timeline: [...artifacts.events()],
      attempts: [...attempts],
      env,
      evidence: [...evidence],
    };
  };

  // (j) Teardown in finally — even a blocked or crashing run cleans up
  // exactly the resources its runId owns (方案 §10 数据隔离铁律).
  let result: RunResult | undefined;
  let tornDown: string[] = [];
  let teardownError: string | undefined;
  try {
    result = await run();
  } finally {
    try {
      tornDown = await adapter.teardown();
    } catch (e) {
      teardownError = e instanceof Error ? e.message : String(e);
    }
  }
  if (result === undefined) throw internalError("run produced no result");
  if (teardownError === undefined)
    await artifacts.event("torn-down", { paths: tornDown });
  else await artifacts.event("teardown-error", { error: teardownError });

  // (k) Final result.
  result.finishedAt = new Date().toISOString();
  result.timeline = [...artifacts.events()];
  await artifacts.writeResult(result);
  return result;
}
