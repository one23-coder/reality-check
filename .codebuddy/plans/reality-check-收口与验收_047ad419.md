---
name: reality-check-收口与验收
overview: 修复未提交改动中的 P0 正则缺陷，为新增的证据核对/单一口径/所有权拒绝行为补齐单元测试，跑全量 verify 与正反例矩阵实测，同步修正方案文档与 README 的阶段标注，最终收口为一次可复核的提交。
todos:
  - id: baseline
    content: 跑 npm run verify 与 6 场景 check、两个验收脚本，产出基线失败清单
    status: completed
  - id: impact-scan
    content: 用 [subagent:code-explorer] 扫描 missingEvidenceTypes 与 scenario 可选的全部读写点
    status: completed
    dependencies:
      - baseline
  - id: fix-defects
    content: 修正 normalizeSql 正则、恢复 engine 注释与 plan 退出码两层契约
    status: completed
    dependencies:
      - impact-scan
  - id: type-contract
    content: 在 protocol 定义 MissingEvidenceType 并同步 validator，去掉 assert.ts 强转
    status: completed
    dependencies:
      - impact-scan
  - id: review-diff
    content: 用 [skill:review-agent] 复核未提交改动，收敛剩余缺陷
    status: completed
    dependencies:
      - fix-defects
      - type-contract
  - id: tests
    content: 新增证据核/单一口径/降级测试用例，并更新 cli.test.ts 过期断言
    status: completed
    dependencies:
      - review-diff
  - id: e2e-matrix
    content: 跑正反例矩阵（含故障注入）、blocked 与串行稳定性，记录退出码与 runId
    status: completed
    dependencies:
      - tests
  - id: docs-commit
    content: 收口方案文档与 README（含附录 A.6），提交并给出标签与下一步排队建议
    status: completed
    dependencies:
      - e2e-matrix
---

## 项目审查结论

**当前阶段判定**（按 `Reality-Check-工程阶段方案.md` §0 自身的证据口径：✅/◐/⬜ 不许混用、第三层必须是真实浏览器端到端）：

- **阶段 0/1（基线 + MVP）：✅ 可信** —— 有 `scripts/blocked-case.mjs`、`scripts/serial-stability.mjs`、`docs/接入耗时记录.md`（含逐条阻碍）、附录 A.1/A.2 正反例矩阵、WSL2 Linux 记录、第二应用 exam-seat-app 内核零改动接入。
- **阶段 2/3（工作台 / MCP+CI）：实体建成，但只能算 ◐** —— §6/§7 判定项中「≥3 个不同项目试用」「预先标注案例集评估」「CLI/工作台/MCP 三入口逐字段一致」「未参与开发的助手闭环」均无取证。
- **阶段 4：明确 ◐** —— 仅 adapter-sdk + 一致性套件；受控事件注入、虚拟时间、macOS 入矩阵、版本兼容自动化验证、脱敏检查、安装/升级/迁移/排障文档全部未开始。

**核心风险：HEAD(v0.1.0) 宣称「阶段 0–4 已验收」，但工作区有 13 个文件、+223/-123 的暂存未提交改动，这批改动触及 §10 不可后补条款，却零新增核心测试、无实测证据；且已确认 `normalizeSql` 正则缺陷与 cli.test.ts 过期断言两处会让 `npm test` 变红。**

## 本次要做的事（用户选定：先收口再前进）

1. 建立基线：`npm run typecheck → build → test` + 6 场景 `check`，拿到真实红名单（用户已授权全部写文件验证动作）。
2. 修 P0 缺陷：`engine.ts` `normalizeSql` 正则 `/s+/g` → `/\s+/g`。
3. 收回被放宽的类型契约：`missingEvidenceTypes` 由 `string[]` 改为带语义联合 `MissingEvidenceType[]`（result 1.0 内收紧，不升版本，理由记入 A.6）。
4. 修复 `plan` 退出码契约：空场景目录仍应为 64；无线索且无可用模型应为退出码 0 + 如实打印「未选择任何场景」，不猜默认。
5. 为「证据核对 / 单一口径 / 所有权拒绝 / 证据缺失降级」补单元测试与跨包用例。
6. 端到端重测：6 场景 × 正反例矩阵 + blocked + 串行稳定性（只跑这一次完整矩阵，基线阶段不预跑，避免 10 次浏览器全量运行重复两遍）。
7. 文档收口（方案 §3/§5/§6/§7/§8/§11 + 附录 A.6 + README 核心约束），把无取证的 ✅ 改回 ◐ 或补证据；按仓库既有「特性级大提交」惯例收口为一次提交。

## 不做的事（本次明确排除）

阶段 4 剩余功能、seedRole 内核实现（A.5 限制①）、阶段 2/3 外部取证项 —— 仅在 §11 排队，不实现。**不新建 `docs/下一步待办.md`**（避免文档蔓延，排队顺序写入方案 §11 既有章节）。

## 技术栈

沿用仓库现状：TypeScript 严格模式 monorepo（npm workspaces），Node ≥ 22.13，ESM，`tsc -b` 项目引用构建，`node --test` 唯一测试运行器，SQLite(node:sqlite) + Playwright Chromium。不引入新依赖、不改构建方式、不加测试框架。

## 实现方案

**策略**：先拿红名单，再按「缺陷 → 类型契约 → 退出码契约 → 复核 → 测试 → 实测 → 文档」收口；每层判据都是退出码 + 结论行 + 运行产物（§0 审查四法）。

### 关键决策与取舍

1. **先验证后修复**：`cli/test/cli.test.ts` 中 `plan` 的断言与新实现语义疑似冲突（**行号系规划期推断，以基线实跑结果为准**），必须先跑一遍拿到完整红名单，避免盲修。
2. **类型收紧而非放任**：`missingEvidenceTypes` 从 `string[]` 收回为联合类型 `MissingEvidenceType = EvidenceKind | "rows" | "columns" | "numeric-cell" | "cell" | "evidence-file"`。`MissingEvidence` 同名联合已存在于 `core/src/assert.ts`，上移到 protocol 即可去掉 `assert.ts` 的 `missing as EvidenceKind[]` 强转，validator 同步改为 `vEnum`。**协议兼容性决策**：这是对 result 1.0 合法文档空间的收紧（所有现有生产方已只产出这些取值），属向后兼容的约束强化，不升版本号，决策理由记录于附录 A.6。
3. **`plan` 退出码两层语义**：`savedScenarios.length === 0` 仍映射 64（配置非法，保住现有测试与 README 退出码表）；有候选但无线索且无可用模型 → 退出码 0 且 stdout 明确「未选择任何场景」，不猜默认（§3.3 规则 9，可预期行为不包装成错误）。
4. **「db 已存在则拒绝启动」保持**：`dataRoot = join(runDir,"data")` 且 runId 每次新建，正常路径不触发；它把「残留/所有权不清」变成 blocked 而非静默复用，是铁律要求的正确失败方向。由 `serial-stability.mjs` 与 CI clean-env-twice 实测确认不冲突。
5. **测试粒度**：核心新行为用「最小假适配器」做跨包级测试（`LocalWebAdapterV1` 接口仅 7 个方法），不启动浏览器即可覆盖 `executeScenario` 降级链路（三层验证链第二层）；第三层由真实矩阵承担。先例：`adapter-sdk/test/sdk.test.ts` 用伪造证据适配器做反例。

### 性能与影响面

`verifyEvidenceRef` 对每个证据引用做一次 `stat + readFile + sha256`；每观察器 1 个证据文件、每场景 2–3 个观察器，代价可忽略。`artifacts.evidence()` 已读过一遍文件，避免同一路径重复读两次以上。

## 已确认的具体修改点（实地核验）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| `packages/core/src/engine.ts:35-37` | `sql.replace(/s+/g, " ")` | 改为 `/\s+/g`；补「仅空白差异应通过、实质差异应 configError」双用例 |
| `packages/core/src/engine.ts` 约 71 行 | 原注释 `// (b) Capability gate.` 被删 | 恢复，保持 (a)~(k) 分段注释完整 |
| `packages/protocol/src/result.ts:56-58,131` | `missingEvidenceTypes?: string[]` + `vArray(vString)` | 引入并导出 `MissingEvidenceType`，字段类型与 validator 同步收紧 |
| `packages/core/src/assert.ts:20-23,89-103` | 本地重复定义 `MissingEvidence` + `missing as EvidenceKind[]` 强转 | 改从 protocol 引入联合类型，删除强转 |
| `packages/core/src/engine.ts` 约 325 行 | 降级写死 `["evidence-file"]` | 沿用，取值必须属于新联合类型 |
| `packages/cli/src/commands/plan.ts` | 不再 throw，任何情况都打印 "no scenario chosen" | 空场景目录 → `configError` (64)；无线索无模型 → 退出码 0 + 明确输出 |
| `packages/cli/test/cli.test.ts` 约 273-294（以基线实跑为准） | 疑似断言 `needsModel=false` / 空场景目录 64 + stderr 文案 | 按基线红名单更新为新语义；保留「有场景不猜默认 → 无 `scenario=` 输出」正向断言 |


## 目录结构

```
d:/aimanage/Reality Check/
├── packages/protocol/src/result.ts                 # [MODIFY] 导出 MissingEvidenceType；missingEvidenceTypes 与 validator 收紧
├── packages/core/src/engine.ts                     # [MODIFY] 修正 normalizeSql 正则；恢复 (b) 段注释；降级值改用新联合类型
├── packages/core/src/assert.ts                     # [MODIFY] 删除本地重复联合与强转，改用 protocol 的 MissingEvidenceType
├── packages/cli/src/commands/plan.ts               # [MODIFY] 恢复两层退出码契约
├── packages/core/test/engine-evidence.test.ts      # [NEW] 最小假适配器覆盖：单一口径正反例、证据引用四类判据、inconclusive 降级链路、rollUpVerdict 退出码语义
├── packages/core/test/artifacts.test.ts            # [MODIFY] 追加 verifyEvidenceRef 用例（悬空/空文件/哈希不一致/路径逃逸/合法返回 null）
├── packages/cli/test/cli.test.ts                   # [MODIFY] 更新过期 plan 断言，新增「有场景但不猜默认」用例
├── packages/adapter-local-web/test/adapter.test.ts # [MODIFY] 追加「db 已存在则拒绝启动」与 evidenceError 落盘用例
├── Reality-Check-工程阶段方案.md                    # [MODIFY] §3.1/§5 补本次改动；§6/§7 无取证项改 ◐；§11 更新下一步排队；新增附录 A.6；更新 A.4/A.5
└── README.md                                       # [MODIFY] 「核心约束」补「内核逐条核对证据引用（存在+哈希）」「单一口径 SQL 校验」「拒绝重名 db」
```

## 关键代码结构

```ts
// packages/protocol/src/result.ts —— 证据类型 + 观察缺口的全集，替代被放宽的 string[]
export type MissingEvidenceType =
  | EvidenceKind                                        // 文件类缺失
  | "rows" | "columns" | "numeric-cell" | "cell"        // 观察结果本身缺失（core/src/assert.ts 现有取值）
  | "evidence-file";                                    // 内核核对证据引用失败（engine.ts 新增取值）

export interface RuleEvaluation {
  // ...
  missingEvidenceTypes?: MissingEvidenceType[];         // validator 同步改为 vEnum(MISSING_EVIDENCE_TYPES)
}
```

```ts
// packages/cli/src/commands/plan.ts —— 恢复后的两层契约
if (savedScenarios.length === 0) throw configError("planning failed: no scenario available ..."); // exit 64
const decision = await planScenario({ request, savedScenarios });
const stdout = decision.scenario !== undefined
  ? `plan: scenario=${decision.scenario.id}`
  : "plan: no scenario chosen (no category clue and no usable model; a default is never guessed)";
```

## 实施要点（防回归）

- 全仓 `exactOptionalPropertyTypes`：`missingEvidenceTypes` 要么带值、要么完全不带，不写 `undefined`。
- `MissingEvidenceType` 落地后全仓 grep `missingEvidenceTypes` 写入点（已知：`core/src/assert.ts`、`core/src/engine.ts`、`reporter/test/reporter.test.ts` fixture）逐个对齐；`reporter/src/html.ts` 只读侧 `join(", ")` 不受影响。
- 反馈回路：改完先 `npm run typecheck`（最快），再 `npm run build && npm test`；新增浏览器端到端用例注意 180s 超时。
- exam 侧一律 `--config .reality-check.exam.json`；exam 只能声明 `seat-count` / `seats-left` / `reservation-holder`（`waitlist-head` / `waitlist-order` 硬编码 `course_id` 对 exam 库必然报错）。
- 受伤面积控制：不触碰 planner 已验证的无线索分支语义、不动 adapter-sdk 一致性套件、不做无关重构。
- **并行化**：baseline（实跑红名单）与 impact-scan（只读扫描）互不依赖，并行执行；fix-defects 与 type-contract 亦可并行（不同文件，前者 engine/cli，后者 protocol/assert）。
- **绿色门禁**：tests 步骤以 `npm run verify` 全绿为完成判据，之后才进入 e2e-matrix；blocked 与串行稳定性脚本只在 e2e-matrix 跑一次（基线不预跑，避免 10 次全量浏览器运行重复执行）。
- **提交策略**：遵循仓库既有「特性级大提交」惯例（如 dcb8c31 eqStr 跨 protocol+core+adapter+scenarios 单提交），代码+测试+文档收口为一次提交，提交信息列明改动点与实测证据；**暂不打标签**（v0.2.0 留待阶段 2/3 取证项补齐后再定，诚实反映 ◐ 状态）。

## Agent Extensions

### Skill

- **review-agent**
- 用途：对未提交改动做只读、缺陷优先的复核，重点是 §10 铁律相关新代码（`verifyEvidenceRef`、`invalidEvidence` 降级、所有权拒绝、planner 语义变更）
- 预期产出：按严重程度排序的可执行缺陷清单（含已知之外的遗漏项），作为测试任务的输入

### SubAgent

- **code-explorer**
- 用途：定位 `missingEvidenceTypes` 全部读写点、`PlanDecision.scenario` 全部消费点（CLI / workbench / reporter / mcp-server）及 `PLACEHOLDER_SCENARIO` 删除后的残留引用
- 预期产出：完整影响面清单，确保类型收紧与接口变更不遗漏调用点；与 baseline 并行执行