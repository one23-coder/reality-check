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
  type MissingEvidenceType,
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
import {
  claimDataRoot,
  insideRoot,
  newRunId,
  type OwnershipRegistry,
} from "./ownership.js";

/** SQL whitespace normalization for the 单一口径 comparison: runs of
 * whitespace (including newlines) collapse to one space, so a scenario may
 * re-wrap the manifest's SQL without changing its identity — but ANY other
 * difference (a different column, a different WHERE clause) stays visible and
 * is rejected as a config error. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

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
  // 单一口径 (方案 §3.3 规则 2): the executed SQL is the adapter manifest's.
  // A scenario whose observer SQL differs from the manifest's is a config
  // error — otherwise the report would display one query and judge another.
  for (const o of scenario.observers) {
    const declared = manifest.observers[o.id];
    if (declared === undefined) continue;
    if (normalizeSql(o.sql) !== normalizeSql(declared.sql))
      throw configError(
        `observer "${o.id}" SQL differs between scenario and adapter manifest (单一口径 violated)`,
      );
    for (const col of o.expectColumns)
      if (!declared.columns.includes(col))
        throw configError(
          `observer "${o.id}" expects column "${col}" which the adapter manifest does not declare`,
        );
  }

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

  /** Data root this run owns (方案 §10): claimed before the environment starts,
   * registered with every resource the app creates under it, torn down in the
   * finally block below. */
  const dataRoot = join(artifacts.dir, "data");
  let registry: OwnershipRegistry | undefined;

  const run = async (): Promise<RunResult> => {
    // (d) Environment. Any failure here is "blocked", never an exception.
    let env: EnvSummary;
    try {
      // 数据隔离铁律 (§10): the kernel CLAIMS the data root before anything
      // runs. A root that already holds content without this run's ownership
      // marker is refused — reusing someone else's data must never look like a
      // business result.
      registry = await claimDataRoot(dataRoot, runId);
    } catch (e) {
      await artifacts.event("blocked", { stage: "claimDataRoot", ...errorDetail(e) });
      return blockedResult("claimDataRoot failed");
    }
    try {
      // 规则 7: the scenario's role declarations (incl. seedRole) travel WITH
      // the environment. Seeding an initial occupant must happen while the app
      // starts; registerAccounts() only creates accounts afterwards.
      env = await adapter.setupEnv({
        runDir: artifacts.dir,
        seed,
        dataRoot,
        roles: scenario.roles,
      });
    } catch (e) {
      await artifacts.event("blocked", { stage: "setupEnv", ...errorDetail(e) });
      return blockedResult("setupEnv failed");
    }
    // Whatever the app created under our root is registered against THIS run id
    // (方案 §10: 只清理台账内 ownedBy === runId 的资源).
    if (env.dbPath !== undefined && insideRoot(dataRoot, env.dbPath)) {
      registry.register("db", env.dbPath);
      await registry.flush();
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
      // 铁律 3 applies to STEP evidence exactly as it does to observer
      // evidence: the kernel verifies every ref (in evidence/, non-empty,
      // sha256 matches) before it enters the result, and names every ref it
      // had to drop. Step evidence is not an assertion subject, so a dropped
      // ref never changes the verdict — it is surfaced in the timeline.
      const validRefs: EvidenceRef[] = [];
      for (const ref of attempt.evidence ?? []) {
        const problem = await artifacts.verifyEvidenceRef(ref);
        if (problem === null) validRefs.push(ref);
        else
          await artifacts.event("evidence-invalid", {
            stepId: attempt.stepId,
            actor: attempt.actor,
            file: ref.file,
            reason: problem,
          });
      }
      if (validRefs.length === 0) delete attempt.evidence;
      else if (validRefs.length !== attempt.evidence?.length) attempt.evidence = validRefs;
      evidence.push(...validRefs);

      attempts.push(attempt);
      const detail: Record<string, unknown> = {
        stepId: attempt.stepId,
        op: attempt.op,
        outcome: attempt.outcome,
      };
      if (attempt.httpStatus !== undefined) detail.httpStatus = attempt.httpStatus;
      if (attempt.detail !== undefined) detail.detail = attempt.detail;
      if (attempt.evidence !== undefined) detail.evidence = attempt.evidence.length;
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

    // (f2) A step that could not be EXECUTED destroys the scenario's premise:
    // the business actions never happened, so any verdict derived from the
    // resulting state would be a claim about a run that did not take place —
    // including a false "passed" when the untouched state happens to satisfy
    // the assertions. §10: that is an environment/tool failure, i.e. blocked
    // (exit 3), never a business conclusion. "rejected" / "no-nav" are NOT
    // errors: they are the app's honest answers to a step that did execute.
    const erroredSteps = attempts.filter((a) => a.outcome === "error");
    if (erroredSteps.length > 0) {
      await artifacts.event("blocked", {
        stage: "steps",
        steps: erroredSteps.map((a) => a.stepId),
        reasons: erroredSteps.map((a) => String((a.detail as { error?: unknown } | undefined)?.error ?? "unknown")),
      });
      return blockedResult("one or more scenario steps could not be executed");
    }

    // (g) Observations.
    const readings = new Map<string, ObserverReading>();
    const observerSeq = new Map<string, number>();
    // Observer ids whose reading lost at least one evidence ref to
    // verification failure (the per-file reasons live in the events above).
    const unverifiableObservers = new Set<string>();
    for (const observer of scenario.observers) {
      try {
        const reading = await adapter.observe(observer.id);
        // 铁律 3: the kernel verifies EVERY evidence ref it accepts — the file
        // must exist inside this run's evidence dir and hash to the ref's
        // sha256. Invalid refs are dropped and named; they downgrade any
        // assertion citing the observer to inconclusive (§10).
        const validRefs: EvidenceRef[] = [];
        for (const ref of reading.evidence) {
          const problem = await artifacts.verifyEvidenceRef(ref);
          if (problem === null) {
            validRefs.push(ref);
          } else {
            await artifacts.event("evidence-invalid", {
              observerId: observer.id,
              file: ref.file,
              reason: problem,
            });
          }
        }
        if (validRefs.length !== reading.evidence.length) {
          unverifiableObservers.add(observer.id);
          reading.evidence = validRefs;
        }
        readings.set(observer.id, reading);
        evidence.push(...validRefs);
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
      let evaluation = evaluateAssertion(assertion, readings);
      if (unverifiableObservers.has(assertion.observer)) {
        // Unverifiable evidence downgrades the verdict to inconclusive (§10),
        // but the ORIGINAL reason (e.g. "rows"/"cell" gap already reported by
        // the evaluator) must survive: 证据缺失必须按要求逐项列出，不互相覆盖.
        const gaps = new Set<MissingEvidenceType>(evaluation.missingEvidenceTypes ?? []);
        gaps.add("evidence-file");
        evaluation = {
          ruleId: evaluation.ruleId,
          assertionId: evaluation.assertionId,
          verdict: "inconclusive",
          observed: evaluation.observed,
          expected: evaluation.expected,
          evidenceRefs: evaluation.evidenceRefs,
          missingEvidenceTypes: [...gaps],
        };
      }
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
  let ownedEntries = 0;
  let ownedRemoved: string[] = [];
  try {
    result = await run();
  } finally {
    try {
      tornDown = await adapter.teardown();
      // The ledger is the second, independent cleanup pass: whatever the
      // adapter left behind under OUR root is removed here, and nothing the
      // ledger does not own is ever touched (§10).
      if (registry !== undefined) {
        ownedEntries = registry.ownedCount();
        ownedRemoved = await registry.teardown();
      }
    } catch (e) {
      teardownError = e instanceof Error ? e.message : String(e);
    }
  }
  if (result === undefined) throw internalError("run produced no result");
  if (teardownError === undefined)
    await artifacts.event("torn-down", {
      paths: tornDown,
      ownership: { entries: ownedEntries, removed: ownedRemoved },
    });
  else await artifacts.event("teardown-error", { error: teardownError });

  // (k) Final result.
  result.finishedAt = new Date().toISOString();
  result.timeline = [...artifacts.events()];
  await artifacts.writeResult(result);
  return result;
}
