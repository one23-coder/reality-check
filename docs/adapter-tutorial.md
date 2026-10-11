# 适配器开发教程（从零接入你自己的应用）

适配器是唯一的「应用相关」代码：它启动应用、驱动页面、读库、采集证据、收尾清理。**契约定义在 [adapter-sdk.md](./adapter-sdk.md)**（那是作者的规范，本文是动手步骤）；协议字段见 [protocol-reference.md](./protocol-reference.md)。

> 目标：不改执行内核就能接入一个新项目。方案 §5 的硬门槛正是「仅凭文档 + 适配层接入第二个独立应用」——`fixtures/exam-seat-app` 就是这么接进来的（见 [接入耗时记录.md](./接入耗时记录.md)，内核零改动，实测约 2–17 分钟）。

---

## 0. 你的应用需要满足什么

1. **本机可启动**：`node <entry>` 或等价命令，监听一个可配置端口（用 `RC_PORT` 环境变量传入）。
2. **有健康检查**：`GET /healthz` 返回 2xx（`waitForHealth` 会轮询它）。
3. **表单是原生 POST + 绝对 action URL**：相对 action 会被解析到页面路径前缀下变成 404；`fetch + preventDefault` 会让「点击完成」早于「服务端处理完成」。
4. **业务状态可被 SQL 读出**：能拿到库文件路径（`RC_DB`），观察器直接查库——判定只认数据库，不认页面文字。
5. **能接受初始数据**：`RC_SEED` 传入角色声明，`seedRole: "holder"` 需要在启动时**占用初始名额**。

---

## 1. 装好骨架

```ts
import {
  freePort, waitForHealth, spawnApp, sha256File, writeEvidenceFile,
  extractSqlTables, freshSqliteRead,
  type LocalWebAdapterV1, type AdapterManifest, type Attempt, type EnvSummary,
  type EvidenceRef, type EvidenceKind, type ObserverReading, type Role, type Step, type StepContext,
} from "@rc/adapter-sdk";
```

`@rc/adapter-sdk` 是唯一的 import 点：契约类型 + 电池 + 一致性套件 + 一个零依赖演示应用。

## 2. `manifest()`：先把能力说清楚

```ts
const OBSERVERS = {
  "order-count": { sql: "SELECT COUNT(*) AS n FROM orders", tables: ["orders"], columns: ["n"] },
};

manifest(): AdapterManifest {
  return {
    protocol: { manifest: "1.0" },
    adapterId: "adapter-my-app",
    adapterVersion: "0.1.0",
    scenarioVersion: "1.1",              // 必须覆盖当前 SCENARIO_VERSION（不足则内核拒绝）
    supportedOps: ["navigate", "register", "login", "fill", "click", "submit", "wait", "barrier"],
    supportedAssertions: ["eq", "ne", "gt", "gte", "lt", "lte", "countEq", "eqStr"],
    observedTables: ["orders", "accounts"],
    evidenceKinds: ["screenshot", "dom-snapshot", "page-text", "sql-dump"],
    barriers: true,
    observers: OBSERVERS,
  };
}
```

清单**必须诚实**：写了 `barriers: true` 就要真的能并发提交；`evidenceKinds` 里声明的每一类都要真的能落盘并通过哈希核对。

## 3. `setupEnv()`：启动环境（角色声明在这里兑现）

```ts
async setupEnv({ runDir, seed, dataRoot, roles }): Promise<EnvSummary> {
  this.runDir = runDir;
  const port = await freePort();                     // 规则 10：并行运行必须各用独立端口
  const dbPath = `${dataRoot}/app.db`;
  const env = {
    ...process.env,
    RC_PORT: String(port),
    RC_DB: dbPath,
    RC_SEED: JSON.stringify(roles.map((r) => ({
      username: r.account.username, password: r.account.password, seedRole: r.seedRole,
    }))),
  };
  this.app = spawnApp(APP_ENTRY, env);
  await waitForHealth(`http://127.0.0.1:${port}`, 15_000);
  return { appVersion: "1.0.0", adapterVersion: "0.1.0",
           baseUrl: `http://127.0.0.1:${port}`, seed, platform: process.platform, dbPath };
}
```

三个要点：

- **`roles` 必须在启动时用上**（规则 7）：`registerAccounts` 之后再建账号无法追溯占位，`holder` 的「占用初始名额」只能在这里兑现。
- **`baseUrl` 返回时必须已健康**，否则内核判 blocked。
- **`dbPath` 如实上报**：内核会把它登记进所有权台账，`teardown` 后做兜底清理。
- **不要**删除/重置 `dataRoot` 里不属于你的内容；内核启动前已用 `ownership.json` 认领该目录（已有内容而无标记会直接 blocked）。

## 4. `registerAccounts()` / `runStep()`：动作与证据

```ts
async runStep(step: Step, ctx: StepContext): Promise<Attempt> {
  const page = await this.pageFor(step.actor);       // 每个角色一个独立上下文
  const started = Date.now();
  let attempt: Attempt;
  try {
    switch (step.op) {
      case "navigate":
        await page.goto(this.baseUrl + String(step.params?.path ?? "/"), { waitUntil: "networkidle" });
        attempt = { stepId: step.id, actor: step.actor, op: step.op, outcome: "completed" };
        break;
      case "submit":
        await page.click("button[type=submit]");
        await page.waitForLoadState("networkidle");
        attempt = {
          stepId: step.id, actor: step.actor, op: step.op,
          outcome: isRejected(await readBanner(page)) ? "rejected" : "completed",
          detail: { banner: (await readBanner(page)).text },
        };
        break;
      default:
        throw new Error(`op "${step.op}" is not implemented by this adapter`);
    }
  } catch (e) {
    // 执行不了 → error（内核据此判 blocked），绝不静默成功
    attempt = { stepId: step.id, actor: step.actor, op: step.op, outcome: "error",
                detail: { error: e instanceof Error ? e.message : String(e) } };
  }
  // 采集即落盘：把本步证据挂在 attempt 上，内核会逐条核对后才登记
  try {
    attempt.evidence = [
      await writeEvidenceFile(ctx.runDir, `step-${step.id}.png`, await page.screenshot({ fullPage: true }), { kind: "screenshot", actor: step.actor }),
      await writeEvidenceFile(ctx.runDir, `step-${step.id}.html`, await page.content(), { kind: "dom-snapshot", actor: step.actor }),
    ];
  } catch (e) {
    attempt.detail = { ...(attempt.detail ?? {}), evidenceError: e instanceof Error ? e.message : String(e) };
  }
  return attempt;
}
```

- **outcome 必须如实**：点击没触发导航 → `no-nav`；被应用拒绝 → `rejected`；执行不了 → `error`。`error` 会让整轮变 blocked，所以不要把业务拒绝误报成 error，也不要把 error 吞成 completed。
- 每步耗时由**内核**测量并写入 `durationMs`，你不需要自己算。
- 证据引用必须指向**真的写进 `<runDir>/evidence/` 的字节**，`sha256` 用 `sha256File`/`writeEvidenceFile` 生成——内核会重新核对。
- `runBarrier(steps, ctx)`：并发提交一个屏障组，返回的 Attempt **顺序必须与输入一致**。

## 5. `observe()`：只读、用清单 SQL、新连接

```ts
async observe(observerId: string): Promise<ObserverReading> {
  const def = OBSERVERS[observerId];
  if (!def) throw new Error(`unknown observer "${observerId}"`);
  // SQL 层白名单：SQL 里出现的表必须都在 observedTables 内
  for (const table of extractSqlTables(def.sql)) {
    if (!this.observedTables.includes(table)) throw new Error(`table "${table}" is outside the whitelist`);
  }
  // 每次读取都新建连接：被测应用在另一进程以 WAL 写入，长连接会停在旧快照
  const rows = await freshSqliteRead(this.dbPath, def.sql, this.observedTables);
  const ref = await writeEvidenceFile(this.runDir, `obs-${observerId}-${++this.n}.json`,
    JSON.stringify({ sql: def.sql, rows }, null, 2), { kind: "sql-dump" });
  return { observerId, columns: [...def.columns], rows, evidence: [ref] };
}
```

- 观察器 SQL **只能**来自清单；场景里写的 SQL 必须与它逐字同源（单一口径，`check` 会拒）。
- 独立性靠「每次新建连接 + SQL 白名单」，**不要**靠 SQLite 的 `readOnly` 标志（看不到 WAL）。

## 6. `teardown()`：只清理自己的东西

```ts
async teardown(): Promise<string[]> {
  const removed: string[] = [];
  if (this.tornDown) return removed;          // 幂等：可以安全调用两次
  this.tornDown = true;
  await this.app?.stop();
  await this.browser?.close().catch(() => {});
  for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
    if (existsSync(f)) { await fsp.rm(f, { force: true }); removed.push(f); }
  }
  return removed;
}
```

**绝不动外部文件**：一致性套件会预埋一个「外来文件」，你的 teardown 结束后它必须原样存在。

## 7. 跑一致性套件（发布前的门）

```bash
node -e "import('@rc/adapter-sdk').then(async m => console.log(await m.runConformanceSuite(
  myAdapterFactory({ appPath: 'path/to/your/app' }),
  { appPath: 'path/to/your/app', workDir: '.sdk-work' })))"
```

六项检查：清单合法、环境生命周期、证据落盘哈希、新鲜连接观察、屏障声明诚实性、所有权清理。**伪造证据的反例会被当场抓住**——套件就是为抓这个而存在的。

## 8. 接到项目里（三个文件就够）

1. `.reality-check.json`：

```json
{ "tools": "0.1.0",
  "app": { "kind": "local-web", "entry": "path/to/your/app/server.js" },
  "adapter": { "module": "@rc/adapter-local-web" },
  "runsDir": "runs", "scenariosDir": "scenarios" }
```

2. **声明你自己应用的观察器**（见 §8.1 —— 这一步不能省，观察器属于应用）。
3. 第一个场景：照 [scenario-guide.md](./scenario-guide.md) §1 的最小示例写，观察器用你清单里已有的 id。
3. 跑：

```bash
node packages/cli/dist/src/main.js check scenarios/yours.json      # 结构 + 能力（不启动应用）
node packages/cli/dist/src/main.js run   scenarios/yours.json --verbose
```

### 8.1 观察器：写在你的应用旁边，不要改适配器源码

`adapter-local-web` 自带的 `booking-count` / `capacity-left` / `seats-left` 等是**两个参考应用的预设**（绑在 `course-1`、`exam-1` 这些主键上），不是通用能力。接入你自己的应用时，在**应用入口旁**放一个 `reality-check.observers.json`：

```json
{
  "observedTables": ["orders", "stock"],
  "observers": {
    "orders-count": {
      "sql": "SELECT COUNT(*) AS n FROM orders",
      "tables": ["orders"],
      "columns": ["n"]
    },
    "stock-left": {
      "sql": "SELECT qty - (SELECT COUNT(*) FROM orders WHERE orders.sku = stock.sku) AS left FROM stock WHERE sku = 'SKU-1'",
      "tables": ["stock", "orders"],
      "columns": ["left"]
    }
  }
}
```

三种提供方式（优先级从高到低）：

| 方式 | 用法 |
| --- | --- |
| 应用目录旁的文件 | `<dirname(app.entry)>/reality-check.observers.json`（推荐；CLI/工作台/MCP 都会自动发现） |
| 配置指定路径 | `.reality-check.json` 的 `"adapter": { "observers": "./ops/observers.json" }` |
| 直接传对象 | `createLocalWebAdapter({ appPath, observers })`（供自写适配器/测试使用） |

规则：

- 每个观察器必须给 `sql` / `tables` / `columns`；`tables` 必须都在 `observedTables` 白名单内（SQL 层只读白名单，规则 1）。
- **`sql` 必须是单条 `SELECT` / `WITH`**（去注释后判定；`;` 一律拒绝），表名/列名必须是纯 SQL 标识符。只读是**语句性质**而不只是表名性质：SQLite 的 `prepare("INSERT …").all()` 会返回 `[]` 却真的写入——一条写语句会在运行中改写你的应用状态，那等于伪造结论（规则 28）。
- 坏 JSON、缺 `columns`、表不在白名单、写语句 ⇒ **配置错误（exit 64）并具名原因**，不会静默回退到预设——回退会让同名表查出别的意思。
- 场景里 observer 的 `sql` 仍必须与这份清单一致（规则 2「单一口径」）：只是清单现在来自你的应用配置，不再来自适配器源码。
- **两类「没有」要分清**（规则 29）：应用入口存在却没有这份文件 ⇒ exit 64，并告诉你三种提供方式；应用入口**不存在** ⇒ 环境缺失，运行以 `blocked`（exit 3）结束，观察器根本用不上——这时不会提前变成配置错误。

## 9. 排查表

| 症状 | 多半原因 |
| --- | --- |
| exit 64，`adapter does not support step op` | 场景用了清单没声明的 op |
| exit 64，`SQL differs between scenario and adapter manifest` | 观察器 SQL 与清单不同源（单一口径） |
| exit 64，`observer "x" is not declared by adapter` | 场景观察器 id 不在清单里（清单 = 你的 `reality-check.observers.json`，见 §8.1） |
| exit 64，`observers file not found` / `invalid JSON` / `needs "columns"` / `not in observedTables` | 观察器配置路径不对、JSON 坏、缺字段或表不在白名单（§8.1） |
| exit 64，`no observers declared for app` | 应用入口存在，但旁边没有 `reality-check.observers.json`，也没在配置里指定（§8.1） |
| exit 64，`must start with SELECT or WITH` / `single statement` | 观察器 SQL 是写语句或多语句；只读是语句性质（§8.1、规则 28） |
| exit 64，`not a plain SQL identifier` | `tables`/`columns` 声明了非标识符字符串（它们会被拼进 dump SQL） |
| 退出码是结论值，但 stderr 有 `warning: 结论已落盘…` | 侧车/报告写失败：结论有效（`result.json` 在），但该运行不能 `rerun` / `export --pack`（规则 30） |
| exit 3，`步骤无法执行` | 选择器找不到、导航超时、浏览器断开——不是业务结论 |
| exit 3，`claimDataRoot` | 数据根已有内容且无 `ownership.json` 标记（§10 拒绝在别人数据上跑） |
| exit 2（inconclusive） | 证据不足：观察器 0 行/列缺失/非数值/证据引用核对失败（会列出缺哪类） |
| 适配器报「page has been closed」 | 浏览器/渲染进程中途死亡；检查是否被外部关闭，或改用 `retry`（只对 `error` 生效） |
