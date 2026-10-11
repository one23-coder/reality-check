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
  SUPPORTED_SCENARIO_VERSIONS,
  isSupportedScenarioVersion,
  scenarioVersionAtLeast,
  type Assertion,
  type Attempt,
  type EnvSummary,
  type EvidenceRef,
  type MissingEvidenceType,
  type RuleEvaluation,
  type RunResult,
  type Scenario,
  type Step,
  type TimelineEvent,
  type Verdict,
} from "@rc/protocol";
import type { LocalWebAdapterV1, ObserverReading, StepContext } from "./adapter.js";
import { evaluateAssertion, expectedText, rollUpVerdict } from "./assert.js";
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

/** Does a concurrent group's result match its input? Returns a named reason or
 * null. The adapter interface promises "one Attempt per step, in input order";
 * a kernel that trusts that promise cannot notice a step going missing. */
function barrierShapeProblem(group: readonly Step[], batch: readonly Attempt[]): string | null {
  if (batch.length !== group.length)
    return `adapter returned ${batch.length} attempts for ${group.length} concurrent steps`;
  for (let i = 0; i < group.length; i++) {
    const want = group[i]?.id;
    const got = batch[i]?.stepId;
    if (want !== got) return `adapter returned attempt for "${String(got)}" where step "${String(want)}" was expected (order is part of the contract)`;
  }
  return null;
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
  opts: {
    runsRoot: string;
    seed?: number;
    /** Live progress hook: every timeline event, in order (方案 §12 可观测性). */
    onEvent?: (event: TimelineEvent) => void;
  },
): Promise<RunResult> {
  const manifest = adapter.manifest();

  // (a) Version gate — before any run dir or environment is created.
  // Both 1.0 and 1.1 documents are executable (1.1 adds conditional steps); an
  // adapter must declare that it serves at least the scenario's version.
  const scenarioVersion = String(scenario.protocol.scenario);
  if (!isSupportedScenarioVersion(scenarioVersion))
    throw configError(
      `scenario protocol ${scenarioVersion} not supported (kernel serves ${SUPPORTED_SCENARIO_VERSIONS.join(", ")})`,
    );
  if (!scenarioVersionAtLeast(manifest.scenarioVersion, scenarioVersion))
    throw configError(
      `adapter "${manifest.adapterId}" serves scenario ${manifest.scenarioVersion}, which does not cover this scenario's ${scenarioVersion}`,
    );
  // 条件步骤需要 1.1：1.0 文档混用 `when` 直接拒绝（校验器已在场景层拦，这里
  // 是第二道，保证内核即使拿到未校验对象也不会执行半成品语义）。
  if (scenarioVersion === "1.0" && scenario.steps.some((s) => s.when !== undefined))
    throw configError(`scenario ${scenario.id} declares version 1.0 but uses conditional steps (需要 1.1)`);
  if (manifest.protocol.manifest !== MANIFEST_VERSION)
    throw configError(
      `adapter manifest protocol ${String(manifest.protocol.manifest)} not supported (kernel serves ${MANIFEST_VERSION})`,
    );

  // (b) Capability gate.
  for (const step of scenario.steps)
    if (!manifest.supportedOps.includes(step.op))
      throw configError(`adapter does not support step op "${step.op}" (step ${step.id})`);
  // A retried step has ONE sequential attempt list; a barrier step is submitted
  // concurrently and has no meaningful "retry" — refuse instead of guessing.
  for (const step of scenario.steps)
    if (step.barrier === true && step.when !== undefined)
      throw configError(
        `step "${step.id}" declares both barrier and when; a concurrent group has no per-step condition semantics`,
      );
  for (const step of scenario.steps)
    if (step.barrier === true && step.retry !== undefined)
      throw configError(
        `step "${step.id}" declares both barrier and retry; a concurrent group cannot be retried step-by-step`,
      );
  // 重试 = **重放整个步骤**。对写入动作（submit）来说，只有在"这次尝试什么都没派发
  // 出去"时重放才是安全的：如果提交已经发出、只是读不回结果，再点一次就是**第二笔
  // 业务写入**——而那正是"允许重复提交"的应用（也就是本工具要抓的对象）最容易被
  // 推过断言线的地方。适配器用 `detail.dispatched` 报告这个事实（见 submit 的实现），
  // 内核据此拒绝重放已派发的写入，并在时间线里说明为什么没重试。
  //
  // 注意这里**不能**直接禁止 submit + retry：retry 是第三轮为 Chromium 偶发断开
  // 刻意加的缓解（`scenarios/*-cancel-waitlist.json`），一律禁止会把真实抖动重新变成
  // blocked。判据必须是"有没有派发"，不是"是不是 submit"。
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
  const artifactOpts = opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {};
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
  }, artifactOpts);
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
      expected: expectedText(a),
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
    /** 铁律 3 gate shared by EVERY evidence path — step evidence, observer
     * evidence and `when`-condition observations: verify each ref (in this
     * run's evidence/, non-empty, sha256 matches), NAME the ones that had to be
     * dropped, and return only the verifiable ones. */
    const verifyEvidence = async (
      refs: readonly EvidenceRef[],
      context: Record<string, unknown>,
    ): Promise<EvidenceRef[]> => {
      const valid: EvidenceRef[] = [];
      for (const ref of refs) {
        const problem = await artifacts.verifyEvidenceRef(ref);
        if (problem === null) valid.push(ref);
        else await artifacts.event("evidence-invalid", { ...context, file: ref.file, reason: problem });
      }
      return valid;
    };

    const recordAttempt = async (attempt: Attempt): Promise<void> => {
      // Step evidence is not an assertion subject, so a dropped ref never
      // changes the verdict — it is surfaced in the timeline instead.
      const validRefs = await verifyEvidence(attempt.evidence ?? [], {
        stepId: attempt.stepId,
        actor: attempt.actor,
      });
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
      if (attempt.durationMs !== undefined) detail.durationMs = attempt.durationMs;
      if (attempt.attemptIndex !== undefined) detail.attemptIndex = attempt.attemptIndex;
      await artifacts.event("step", detail, { actor: attempt.actor });
    };

    /** One bounded sequential execution of a step, with optional retry:
     * retried attempts are recorded as `step-retry` events (visible in the
     * timeline) and only the LAST attempt becomes this step's Attempt — so the
     * attempts list stays one entry per step and 规则 17 (error ⇒ blocked)
     * still judges the outcome that actually stands. */
    const runStepWithRetry = async (step: Step): Promise<Attempt> => {
      const maxAttempts = step.retry?.attempts ?? 1;
      const retryOn = new Set(step.retry?.on ?? ["error"]);
      let attempt: Attempt | undefined;
      for (let k = 1; k <= maxAttempts; k++) {
        const started = Date.now();
        try {
          attempt = await adapter.runStep(step, ctx);
        } catch (e) {
          attempt = errorAttempt(step, e);
        }
        attempt.durationMs = Date.now() - started;
        if (k > 1) attempt.attemptIndex = k;
        const detail = attempt.detail as { dispatched?: unknown } | undefined;
        const alreadyDispatched = detail?.dispatched === true;
        const willRetry = k < maxAttempts && retryOn.has(attempt.outcome) && !alreadyDispatched;
        if (k < maxAttempts && retryOn.has(attempt.outcome) && alreadyDispatched) {
          // 不重试，但必须**说出来**：一次没有重试的重试声明，和一个没执行的重试
          // 一样，都是报告里说不清的东西。
          await artifacts.event("step-retry-refused", {
            stepId: step.id,
            attemptIndex: k,
            outcome: attempt.outcome,
            reason: "the attempt had already been dispatched; replaying it would produce a second business write",
          });
        }
        if (!willRetry) return attempt;
        // 被丢弃的这次尝试也已经把截图/DOM 落到磁盘上了。不登记就会变成
        // "孤儿文件"（磁盘上有、证据索引里没有），"每次尝试都留在记录里"也就不成立。
        const discardedRefs = await verifyEvidence(attempt.evidence ?? [], {
          stepId: step.id,
          actor: step.actor,
          stage: "retry",
        });
        evidence.push(...discardedRefs);
        await artifacts.event("step-retry", {
          stepId: step.id,
          attemptIndex: k,
          outcome: attempt.outcome,
          durationMs: attempt.durationMs,
          evidence: discardedRefs.length,
          reason: String((attempt.detail as { error?: unknown } | undefined)?.error ?? attempt.outcome),
        });
      }
      if (attempt === undefined) throw internalError(`step "${step.id}" produced no attempt`);
      return attempt;
    };

    const steps = scenario.steps;
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      if (step === undefined) break; // unreachable; noUncheckedIndexedAccess
      if (step.when !== undefined) {
        // 条件步骤 (场景 1.1, 规则 22): observe the DECLARED observer, judge with
        // the assertion vocabulary, and never guess — an undecidable condition
        // (evidence gap) blocks the run instead of silently taking a branch.
        const condition = step.when;
        const reading = await adapter.observe(condition.observer);
        const validRefs = await verifyEvidence(reading.evidence, {
          stepId: step.id,
          actor: step.actor,
          observerId: condition.observer,
          stage: "when",
        });
        // 与正式观察路径同一口径：证据核验不了 ⇒ 判定不可信。条件路径曾把这条
        // 漏掉——于是证据文件被破坏时条件仍可能判 held 并执行后面那一步（一次
        // 本不该发生的业务动作）。规则 22：无法判定 ⇒ blocked，不替用户选分支。
        if (validRefs.length !== reading.evidence.length) {
          await artifacts.event("blocked", {
            stage: "when",
            stepId: step.id,
            observerId: condition.observer,
            error:
              `cannot decide the condition of step "${step.id}": evidence for "${condition.observer}" ` +
              `failed verification (${reading.evidence.length - validRefs.length} of ${reading.evidence.length} refs rejected)`,
          });
          return blockedResult("the evidence behind a conditional step failed verification");
        }
        evidence.push(...validRefs);
        const assertion: Assertion = {
          id: `when:${step.id}`,
          rule: `when:${step.id}`,
          observer: condition.observer,
          op: condition.op,
          ...(condition.value !== undefined ? { value: condition.value } : {}),
          ...(condition.expected !== undefined ? { expected: condition.expected } : {}),
        };
        const evaluation = evaluateAssertion(assertion, new Map([[condition.observer, reading]]));
        await artifacts.event("when", {
          stepId: step.id,
          observerId: condition.observer,
          verdict: evaluation.verdict,
          observed: evaluation.observed,
          expected: evaluation.expected,
          decision: evaluation.verdict === "held" ? "run" : evaluation.verdict === "violated" ? "skip" : "undecidable",
          evidence: validRefs.length,
        });
        if (evaluation.verdict === "inconclusive") {
          await artifacts.event("blocked", {
            stage: "when",
            stepId: step.id,
            observerId: condition.observer,
            error:
              `cannot decide the condition of step "${step.id}": observation of "${condition.observer}" ` +
              `is inconclusive (missing ${(evaluation.missingEvidenceTypes ?? ["evidence"]).join(", ")})`,
          });
          return blockedResult("a conditional step could not be decided");
        }
        if (evaluation.verdict === "violated") {
          const skipped: Attempt = {
            stepId: step.id,
            actor: step.actor,
            op: step.op,
            outcome: "skipped",
            detail: {
              when: { observer: condition.observer, op: condition.op },
              observed: evaluation.observed,
              expected: evaluation.expected,
            },
            ...(validRefs.length > 0 ? { evidence: validRefs } : {}),
          };
          await recordAttempt(skipped);
          i++;
          continue;
        }
      }
      if (step.barrier === true) {
        const group: Step[] = [];
        while (i < steps.length) {
          const s = steps[i];
          if (s === undefined || s.barrier !== true) break;
          group.push(s);
          i++;
        }
        const started = Date.now();
        try {
          const batch = await adapter.runBarrier(group, ctx);
          const elapsed = Date.now() - started;
          // 接口契约要求"每个步骤一个 Attempt，按输入顺序"。少了谁就说明那个步骤
          // **没被观察到是否执行**：它的业务动作可能凭空消失，而后续断言会在
          // "这一步没发生"的状态上求值——正是假通过。自带适配器不会这样，但内核
          // 不能把这条契约当作前提（一致性问题在 conformance 里查的是适配器，
          // 内核自己也得有这道闸门）。
          const shape = barrierShapeProblem(group, batch);
          for (const attempt of batch) {
            attempt.durationMs = attempt.durationMs ?? elapsed;
            await recordAttempt(attempt);
          }
          if (shape !== null) {
            await artifacts.event("blocked", { stage: "barrier", steps: group.map((s) => s.id), error: shape });
            return blockedResult("a concurrent group returned an unusable set of attempts");
          }
        } catch (e) {
          const elapsed = Date.now() - started;
          for (const s of group) {
            const attempt = errorAttempt(s, e);
            attempt.durationMs = elapsed;
            await recordAttempt(attempt);
          }
        }
      } else {
        await recordAttempt(await runStepWithRetry(step));
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
        const validRefs = await verifyEvidence(reading.evidence, { observerId: observer.id });
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
