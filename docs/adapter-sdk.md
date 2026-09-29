# @rc/adapter-sdk — 适配器作者指南（外部贡献者入口）

> **方案 §8 的目标，原话**：外部贡献者**仅凭 SDK 和文档**（不看内核源码）完成一个适配器并通过一致性测试。
>
> 本文件就是这个"文档"。它完整描述内核对适配器强制执行的全部不变量；你不需要读
> `@rc/core` 或 `@rc/adapter-local-web` 的源码。读完本文 → 实现 8 个方法 → 跑
> `runConformanceSuite` → 全绿即接入完成。

## 1. 安装与导入

```bash
npm install @rc/adapter-sdk        # 连同 @rc/protocol、@rc/core 一起可用
```

```ts
// 这一个导入点提供全部所需：契约类型、工具函数、一致性测试套件、演示应用。
import {
  // 契约类型
  type LocalWebAdapterV1, type StepContext, type ObserverReading,
  type AdapterManifest, type Scenario, type Step, type Role,
  type Attempt, type EnvSummary, type EvidenceRef, type EvidenceKind,
  validateManifest, EVIDENCE_KINDS, SCENARIO_VERSION,
  // 工具函数（batteries）
  freePort, waitForHealth, spawnApp, sha256File, writeEvidenceFile,
  extractSqlTables, freshSqliteRead,
  // 一致性测试套件
  runConformanceSuite,
  // 零依赖演示应用（第三个应用，参考实现）
  startStaticApp,
} from "@rc/adapter-sdk";
```

## 2. 你要实现什么：`LocalWebAdapterV1` 的 8 个方法

内核（执行引擎）只通过这个接口与被测应用对话。它从不直接触碰你的应用。

| # | 方法 | 职责 | 关键约束 |
| --- | --- | --- | --- |
| 1 | `manifest(): AdapterManifest` | 能力声明 | 见 §3；内容必须真实，套件会逐条验证 |
| 2 | `setupEnv({runDir, seed, dataRoot})` | 创建隔离环境并启动应用 | 返回的 `baseUrl` 必须在返回时已健康（`GET /healthz` 2xx）；不得删除/重置 `dataRoot` 里你不拥有的内容 |
| 3 | `registerAccounts(roles)` | 把场景角色注册为应用账号 | 每个角色都必须成功注册；失败必须抛错，不得静默跳过 |
| 4 | `runStep(step, ctx)` | 执行单个场景步骤 | 结果必须**如实**：点击未触发导航报 `"no-nav"`，不得静默成功（规则 6） |
| 5 | `runBarrier(steps, ctx)` | 并发提交一个屏障组 | 一个步骤一个 Attempt，**顺序与输入一致**；`manifest.barriers === false` 时内核不会调用它 |
| 6 | `observe(observerId)` | 用**场景声明的观察器 SQL** 独立读业务状态 | 见 §4（规则 1，最重要的不变量） |
| 7 | `captureEvidence(kind, actor?)` | 采集证据 | **采集即落盘**于 `runDir/evidence/`，返回的 `EvidenceRef.sha256` 必须是文件字节的哈希（铁律 3） |
| 8 | `teardown()` | 清理本次运行拥有的全部资源 | 幂等（可安全调用两次）；返回被清理的路径列表；**只清理自己创建的资源**（§10 所有权） |

### `StepContext`

```ts
interface StepContext {
  runDir: string;          // 本次运行的目录（证据落盘的根）
  seed: number;            // 本次运行的随机种子
  event(kind, detail, actor?, causation?): Promise<number>; // 追加时间线，返回分配的 seq
}
```

`event` 返回的 `seq` 单调递增，是时间线唯一的排序依据；后续事件用它作
`causation`（因果边）。时间相邻只是线索，`causationId` 才是因果边。

### `Attempt`

```ts
interface Attempt {
  stepId: string; actor: string; op: string;
  outcome: "completed" | "rejected" | "no-nav" | "error";
  httpStatus?: number;
  detail?: Record<string, unknown>;
}
```

四类结局的语义是硬性的：业务拒绝是 `rejected`（不是 error）；点击后没有导航是
`no-nav`（**不是** completed）；基础设施异常才是 `error`。

## 3. 能力声明：`AdapterManifest`

```ts
interface AdapterManifest {
  protocol: { manifest: "1.0" };     // 固定 "1.0"（MANIFEST_VERSION）
  adapterId: string;                 // npm 包名或稳定标识
  adapterVersion: string;            // 你的版本号
  scenarioVersion: string;           // 必须是 "1.0"（SCENARIO_VERSION）
  supportedOps: string[];            // 能执行的场景步骤 op（非空）
  supportedAssertions: string[];     // 能判定的断言 op
  observedTables: string[];          // 观察器可读的表白名单（非空）
  evidenceKinds: EvidenceKind[];     // 能产出的证据类型（非空）
  barriers: boolean;                 // 能否并发提交屏障组
  observers: Record<string, { sql: string; tables: string[]; columns: string[] }>;
}
```

**诚实声明是硬要求**，内核按声明在运行前拒绝场景（exit 64）：

- `supportedOps` 里没有的 op，内核不会把该步骤交给你；
- `observers` 里没有声明的观察器 id，断言会被拒绝——断言主体必须复用你声明的
  SQL 口径，**不允许内核或场景另写"等价查询"**（规则 2）；
- `observedTables` 之外的表，任何观察器都不得读（规则 1）；
- `barriers: false` 时，含屏障步骤的场景在创建任何环境之前被内核拒绝；
- `evidenceKinds` 至少要有 `"sql-dump"` 和 `"page-text"`（文档规定的下限；
  浏览器适配器还应含 `"screenshot"`），且只能取自
  `EVIDENCE_KINDS = ["screenshot","dom-snapshot","har","sql-dump","page-text"]`。

## 4. 内核强制的不变量（每一条都被一致性套件验证）

1. **观察器每次读取新建连接再关闭**（规则 1，最重要的不变量）。
   被测应用在**另一个进程**以 WAL 模式写 SQLite。长持连接会停在旧快照；
   `readOnly: true` 根本看不到 WAL 内容。独立性的来源是「独立连接 + SQL 层只读
   白名单」，不靠 SQLite 只读标志。**直接用 SDK 的
   `freshSqliteRead(dbPath, sql, allowedTables)`**：它先做表白名单检查（越界即抛，
   不开连接），再为本次读取新建 `node:sqlite` 连接，`finally` 中关闭。
   套件的验证方式是真实的：它从第二条连接往库里写一行，断言你下一次
   `observe()` 能看见。
2. **断言主体读取必须复用场景声明的观察器 SQL**（规则 2）。你的
   `manifest.observers[id].sql` 就是唯一口径；`observe(id)` 必须原样执行它。
3. **证据采集即落盘，哈希登记**（铁律 3）。`captureEvidence` 返回前，字节必须在
   `runDir/evidence/` 里；`EvidenceRef.sha256` 用 `sha256File`/`writeEvidenceFile`
   计算。返回指向不存在文件的 ref = 占位伪造证据，套件立即抓住。内核登记时核对
   文件存在，缺失即报错；完整性按要求的类型**逐项**核对，不按数量（铁律 4）。
4. **所有权与清理**（§10）。`setupEnv` 拿到的 `dataRoot` 可能已存在（套件会预先
   创建并在里面放一个"外来文件"）：只创建/记录你拥有的资源，`teardown` 只清理
   台账内 `ownedBy === 本次运行` 的资源，**绝不动外来文件**；`teardown` 必须幂等。
   数据根目录已有内容但无所有权标记时，你的适配器应拒绝运行。
5. **端口分配**（规则 10）。并行运行必须各用独立端口。用 `freePort()` 探测，
   通过 `RC_PORT` 环境变量交给应用。
6. **表单提交用原生 POST + 绝对 URL**（规则 5）。相对 action 会被解析到页面路径
   前缀下变成 404；`fetch + preventDefault` 会让"点击完成"早于"服务端处理完成"，
   采样读到旧值——测试自身的时序问题会伪装成业务缺陷。
7. **角色先注册，占位显式声明**（规则 7）。`seedRole: "holder"` 的角色**占用**
   初始名额，`"none"/"waitlisted"` 不占用。把所有角色默认当持有者，会让"要新报名
   的人"被拒，正确实现反被误报。
8. **诚实分类**（规则 6）。`no-nav` 不是成功；HTTP 200、成功页面、无 console error
   都不能证明业务成功——业务真相只来自观察器 SQL。

### 应用侧约定（你的应用要提供什么）

- `GET /healthz` → 2xx，建议返回 `{"ok":true,"app":"...","version":"..."}`；
- 用 `RC_PORT`（端口）与 `RC_DB`（SQLite 文件路径）环境变量；
- SQLite WAL 模式；`RC_SEED`（JSON 数组 `[{username,password,seedRole}]`）用于
  初始账号。
- 参考零依赖实现：`startStaticApp()`（SDK 内置，~150 行 node:http + node:sqlite），
  以及仓库内 `fixtures/booking-app/server.js`、`fixtures/exam-seat-app/server.js`。

### 启动应用的现成零件

```ts
const port = await freePort();
const app = spawnApp(serverJsPath, { ...process.env, RC_PORT: String(port), RC_DB: dbPath });
await waitForHealth(`http://127.0.0.1:${port}`, 15_000);
// ...
await app.stop();           // SIGTERM → 最多等 3s → SIGKILL
```

## 5. 一致性测试套件

```ts
import { runConformanceSuite } from "@rc/adapter-sdk";

const report = await runConformanceSuite(myAdapter, {
  appPath: "/abs/path/to/your-app-server.js",
  workDir: "/tmp/rc-conformance-1",   // 套件的草稿目录
});
console.log(report.passed, JSON.stringify(report, null, 2));
```

报告是纯 JSON（`{adapterId, checks: [{name, pass, detail}], passed}`），可直接进 CI。

| 检查 | 验证什么 |
| --- | --- |
| `manifest-valid` | `validateManifest` 通过；`scenarioVersion === "1.0"`；`supportedOps` 非空；`evidenceKinds` 含文档下限（sql-dump + page-text）；每个观察器的 SQL 与声明表都在 `observedTables` 白名单内 |
| `env-lifecycle` | `setupEnv` 达到健康 `baseUrl`；`teardown` 返回 ≥1 个被清理路径；第二次 `teardown` 幂等不抛 |
| `evidence-on-disk` | 对声明的**每个** `evidenceKinds` 类型，`captureEvidence` 落盘的文件字节哈希等于 `EvidenceRef.sha256`（铁律 3，专抓占位证据）。唯一豁免：抛错原因恰为 "no such table" 且适配器声明的 `observedTables` 确有本应用库中不存在的表（声明超集）时，记为 `excused` 写入 `detail`——ref 指向不存在的文件或哈希不符则**无条件失败** |
| `fresh-connection-observation` | 注册 2 个角色；若 `supportedOps` 允许则走一个最小导航步骤；从**第二条连接**越界写库后，下一次 `observe()` 必须看见变化（规则 1）；越白名单的观察器 SQL 必须被拒绝 |
| `barrier-declaration-honesty` | `barriers: true` ⇒ `runBarrier` 对 2 步组返回 2 个**有序** Attempt 不崩；`barriers: false` ⇒ 内核 `executeScenario` 确实会在建环境前拒绝屏障场景 |
| `ownership-cleanup` | `teardown` 后，适配器在 `dataRoot` 下创建的文件已消失；套件预埋的**外来文件**完好无损（§10 所有权） |

若你的适配器没有通用最小路径（例如没有可导航页面、没有声明观察器或未暴露
`dbPath`），套件会**跳过**对应探针（`pass: true` 并在 `detail` 里注明原因）——
但跳过得越多，可信度越低：接入审核会要求 `detail` 全部为实跑结论。

## 6. 完整最小示例

```ts
import {
  freePort, waitForHealth, spawnApp, writeEvidenceFile, freshSqliteRead,
  runConformanceSuite, type LocalWebAdapterV1, type AdapterManifest,
} from "@rc/adapter-sdk";

export function createMyAdapter(appPath: string): LocalWebAdapterV1 {
  let app: ReturnType<typeof spawnApp> | null = null;
  let baseUrl = "";
  let dbPath = "";
  let runDir = "";
  let seq = 0;
  const OBSERVERS = {
    "note-count": { sql: "SELECT COUNT(*) AS n FROM notes", tables: ["notes"], columns: ["n"] },
  };
  const adapter: LocalWebAdapterV1 = {
    manifest(): AdapterManifest {
      return {
        protocol: { manifest: "1.0" },
        adapterId: "my-adapter", adapterVersion: "0.1.0",
        scenarioVersion: "1.0",
        supportedOps: ["navigate", "register", "login", "fill", "click", "submit", "wait", "barrier"],
        supportedAssertions: ["eq", "ne", "gt", "gte", "lt", "lte", "countEq"],
        observedTables: ["notes"],
        evidenceKinds: ["sql-dump", "page-text"],
        barriers: false,                     // 诚实声明；套件会验证内核确实拒绝屏障场景
        observers: OBSERVERS,
      };
    },
    async setupEnv({ runDir: rd, seed, dataRoot }) {
      runDir = rd;
      const port = await freePort();
      baseUrl = `http://127.0.0.1:${port}`;
      dbPath = `${dataRoot}/app.db`;
      app = spawnApp(appPath, { ...process.env, RC_PORT: String(port), RC_DB: dbPath, RC_SEED: "[]" });
      await waitForHealth(baseUrl, 15_000);
      return { appVersion: "1.0.0", adapterVersion: "0.1.0", baseUrl, seed, platform: process.platform };
    },
    async registerAccounts(roles) { /* POST 到应用的注册接口；失败必须抛 */ },
    async runStep(step, ctx) {
      // 驱动页面/接口，如实分类 completed / rejected / no-nav / error
      await ctx.event("step", { stepId: step.id }, step.actor);
      return { stepId: step.id, actor: step.actor, op: step.op, outcome: "completed" };
    },
    async runBarrier(steps, ctx) { /* 并发提交，按输入顺序返回 Attempt[] */ },
    async observe(observerId) {
      const def = OBSERVERS[observerId as keyof typeof OBSERVERS];
      if (!def) throw new Error(`unknown observer "${observerId}"`);
      const rows = await freshSqliteRead(dbPath, def.sql, Object.keys(OBSERVERS).flatMap(k => OBSERVERS[k as keyof typeof OBSERVERS].tables));
      const ref = await writeEvidenceFile(runDir, `obs-${observerId}-${++seq}.json`, JSON.stringify(rows), { kind: "sql-dump", seq });
      return { observerId, columns: def.columns, rows, evidence: [ref] };
    },
    async captureEvidence(kind, actor) {
      return writeEvidenceFile(runDir, `ev-${++seq}.txt`, "page text…", { kind, actor, seq });
    },
    async teardown() {
      const removed: string[] = [];
      if (app) { await app.stop(); app = null; removed.push(dbPath); }
      return removed;   // 只清理自己创建的资源；幂等
    },
  };
  return adapter;
}

// 自检：
const report = await runConformanceSuite(createMyAdapter(serverJs), { appPath: serverJs, workDir: "./tmp" });
if (!report.passed) throw new Error(JSON.stringify(report, null, 2));
```

## 7. 发布

1. 全绿：`runConformanceSuite` 6 项检查全过，且 `detail` 都是实跑结论（不是跳过）。
2. 语义版本：
   - **patch**：实现修复，接口与清单语义不变；
   - **minor**：新增 `supportedOps`/`evidenceKinds`/`observers`（只增不改），旧场景不受影响；
   - **major**：`scenarioVersion`/`protocol.manifest` 升级或删除能力——内核按
     `scenarioVersion`、`protocol.manifest` 在运行前拒绝不匹配组合（兼容性有自动化
     验证：旧版本场景跑新内核，行为必须符合声明的兼容规则）。
3. `npm pack` 前自检清单：`manifest()` 每次返回一致内容；`teardown` 幂等；不写
   `dataRoot` 之外的任何路径（运行目录除外）；不打印账号、密钥、内部路径到报告
   （证据包脱敏检查）。
4. 发布说明必须包含：支持范围、已验证场景、误报样本、接入限制、复现步骤。

## 8. 复用检验（方案 §8 验收）

接入完成的标准不是"跑通过一次"，而是：**应用作者在后续每次修改/发布前会再次运行
`runConformanceSuite`**。把它挂进你的 CI——报告 JSON 可以直接做门禁。
