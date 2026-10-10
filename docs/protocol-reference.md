# 协议字段速查（六套版本化协议）

本项目的所有跨进程/跨项目契约都是**有版本号**的，且校验器在运行前把关（不合格 → exit 64，绝不半途而废）。字段定义以代码为准（`packages/protocol/src/*.ts`），本文是给人看的速查表。

| 协议 | 版本常量 | 值 | 定义在 | 生产方 → 消费方 |
| --- | --- | --- | --- | --- |
| 场景描述 | `SCENARIO_VERSION` | `1.1`（内核同时接受 `1.0`，见 `SUPPORTED_SCENARIO_VERSIONS`） | `scenario.ts` | 人/规划器 → 内核 |
| 结果 | `RESULT_VERSION` | `1.1` | `result.ts` | 内核 → CLI/工作台/MCP/报告 |
| 适配清单 | `MANIFEST_VERSION` | `1.0` | `manifest.ts` | 适配器 → 内核 |
| 适配接口 | `ADAPTER_IFACE_VERSION` | `1.0` | `core/src/adapter.ts` | 内核 ↔ 适配器 |
| 运行产物 | `ARTIFACTS_VERSION` | `1.0` | `core/src/artifacts.ts` | 内核 → 磁盘/报告 |
| 工具 | `TOOLS_VERSION` | `0.1.0` | `versions.ts` | `.reality-check.json` |

---

## 1. 场景描述 1.1（`scenario.ts`）

```
Scenario { protocol{scenario:"1.0"|"1.1"}, id, name, description, app, seed,
           roles[Role], steps[Step], observers[Observer], assertions[Assertion], rules[Rule] }

Role         { id, account{username,password}, seedRole: "holder"|"none"|"waitlisted", attrs? }
Step         { id, actor, op: StepOp, params?, barrier?, retry?, when? }   // when 需要 1.1
StepRetry    { attempts: 1..5, on?: AttemptOutcome[] }        // on 默认 ["error"]
StepCondition{ observer, op: AssertOp, value?, expected? }    // observer 必须已声明
Observer     { id, sql, tables[≥1], expectColumns[≥1] }
Assertion    { id, rule, observer, op: AssertOp, value?, expected? }
Rule         { id, description }
```

`StepOp` = `navigate | register | login | fill | click | submit | wait | barrier`
`AssertOp` = `eq | ne | gt | gte | lt | lte | countEq | eqStr`（`ASSERT_OPS`，条件步骤复用同一套词汇）

跨引用校验（`validateScenario`）：步骤 `actor` 必须是已声明角色；断言 `observer`/`rule` 必须存在；`eqStr` 必须有 `expected` 且禁 `value`，其它 op 反之；`barrier` 步骤必须成组（≥2）；**`when.observer` 必须已声明、`when` 不得出现在 barrier 步骤、`when` 不得出现在 1.0 文档**；各类 id 不得重复；字段名拼错、缺必填、多未知字段一律拒绝（fail closed）。

## 2. 结果 1.1（`result.ts`）

```
RunResult { protocol{result}, runId, scenarioId, scenarioSha256, seed, startedAt, finishedAt,
            verdict: "passed"|"failed"|"inconclusive"|"blocked",
            ruleEvaluations[RuleEvaluation], timeline[TimelineEvent],
            attempts[Attempt], env[EnvSummary], evidence[EvidenceRef] }

RuleEvaluation { ruleId, assertionId, verdict: "held"|"violated"|"not-evaluated"|"inconclusive",
                 observed, expected, evidenceRefs[EvidenceRef], missingEvidenceTypes? }
Attempt        { stepId, actor, op,
                 outcome: "completed"|"rejected"|"no-nav"|"error"|"skipped",   // skipped = 条件不成立，未执行
                 httpStatus?, detail?, evidence?[EvidenceRef], durationMs?, attemptIndex? }
TimelineEvent  { seq, t, kind, actor?, detail{}, causation? }
EvidenceRef    { kind: EvidenceKind, file, seq, actor?, sha256 }
EnvSummary     { appVersion, adapterVersion, baseUrl, seed, platform, dbPath? }

EvidenceKind         = "screenshot" | "dom-snapshot" | "har" | "sql-dump" | "page-text"
MissingEvidenceType  = EvidenceKind | "rows" | "columns" | "numeric-cell" | "cell" | "evidence-file"
```

关键不变量：

- **`timeline[].seq` 是唯一排序依据**（`t` 只是线索，`causation` 才是因果边）。
- **`evidence[]` 与 `attempts[].evidence[]` 里的每条引用都由内核核对过**（文件在 `evidence/` 内、非空、`sha256` 一致）；核对失败的引用不会出现在结果里，只在时间线留 `evidence-invalid`。
- **`missingEvidenceTypes` 是封闭集合**：校验器拒收未知字符串，缺口必须能归因到具体类型。
- 结果校验器：`resultV`（`result.ts`，未知字段一律拒绝）。`explainResult(result)` / `slowestSteps(result)`（`explain.ts`）是共用的解释层（CLI/MCP 同措辞）。

## 3. 适配清单 1.0（`manifest.ts`）

```
AdapterManifest { protocol{manifest}, adapterId, adapterVersion, scenarioVersion,
                  supportedOps[], supportedAssertions[], observedTables[],
                  evidenceKinds[EvidenceKind], barriers: bool,
                  observers: Record<id, { sql, tables[], columns[] }> }
```

内核用它做**能力门禁**（运行前，exit 64）：步骤 op、断言 op、观察器 id、观察器读的表、场景与清单的 SQL 同源性（单一口径）都在这里比对；`barriers:false` 的适配器遇到屏障场景直接拒绝。`EVIDENCE_KINDS` 与文档下限（`sql-dump` + `page-text`）由 `validateManifest` 与一致性套件校验。

## 4. 适配接口 1.0（`core/src/adapter.ts`）

```
LocalWebAdapterV1 {
  manifest(): AdapterManifest
  setupEnv({ runDir, seed, dataRoot, roles: Role[] }): Promise<EnvSummary>   // roles 含 seedRole（规则 7）
  registerAccounts(roles: Role[]): Promise<void>
  runStep(step, ctx): Promise<Attempt>
  runBarrier(steps, ctx): Promise<Attempt[]>
  observe(observerId): Promise<ObserverReading>       // { observerId, columns[], rows[], evidence[] }
  captureEvidence(kind, actor?): Promise<EvidenceRef>
  teardown(): Promise<string[]>
}
StepContext { runDir, seed, event(kind, detail, actor?, causation?): Promise<number> }
```

## 5. 运行产物 1.0（磁盘布局）

```
runs/<runId>/
  run.json        运行清单：runId、scenarioId、scenarioSha256、seed、versions{}、platform
  events.jsonl    追加式时间线（每行一个 TimelineEvent）
  result.json     RunResult
  evidence/       适配器落盘的证据字节（截图/DOM/观察器 SQL 结果）
  data/          本次运行的数据根 + ownership.json（只清理 ownedBy === runId 的资源）
  cli.json        CLI 侧车（scenarioPath、seed、previousRunId）→ rerun 的入口
  report.json / report.html   报告
```

## 6. 兼容性策略（重要）

- **同一版本内的可选字段扩展是允许的**（旧文档照常解析）：例如 `Attempt.evidence`、`Attempt.durationMs`、`Attempt.attemptIndex`、`Step.retry`、`missingEvidenceTypes` 的类型收紧，都属这一类，已在方案 §3.3 / 附录 A 记录理由。前提是：新增字段可选、旧生产者不产出也合法、收紧只排除「本来就不该出现」的取值。
- **已完成的一次升版：场景/结果 1.0 → 1.1**（2026-10-10，条件步骤 `when` + `skipped` outcome）。做法可作为下次升版的模板：
  1. `versions.ts` 里把 `SCENARIO_VERSION` 提到新值，并用 `SUPPORTED_SCENARIO_VERSIONS` 保留旧值；
  2. 校验器按声明版本分别把关（1.0 出现 `when` 直接拒绝，不猜语义）；
  3. 内核版本门禁改为「声明值受支持 + 适配器清单声明的版本不低于它」（`scenarioVersionAtLeast`）；
  4. 适配器清单、SDK 一致性套件、CLI `check`、MCP `rc_check` 全部改用同一套判断；
  5. 全部场景、正反例矩阵、标注案例集、`docs/` 同步，并重跑证据链。
- **需要下一次升版（1.2+）的变更**：改变既有字段语义、新增必填字段、引入会改变判定结果的新语义（例如循环体或条件分支的组合表达式）。
- **不做的事**：不允许静默兼容（比如「没声明就当默认」）。未知字段一律拒绝，版本不匹配在运行前拒绝。

## 7. 退出码

见 [scenario-guide.md §7](./scenario-guide.md#7-判定与退出码)：`0` passed / `1` failed / `2` inconclusive / `3` blocked / `64` 配置非法 / `70` 工具异常；`VERDICT_EXIT` 是 verdict → 退出码的唯一映射。
