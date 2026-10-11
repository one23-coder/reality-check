# 场景编写指南（面向使用者）

场景是「一次真实的业务过程」的可执行描述：谁、按什么顺序、对应用做了什么动作，以及**做完之后业务状态必须满足什么**。本文只讲怎么写、怎么判、怎么写错，协议字段的逐项定义见 [protocol-reference.md](./protocol-reference.md)。

---

## 1. 最小可用场景

```json
{
  "protocol": { "scenario": "1.1" },
  "id": "my-app-normal",
  "name": "正常下单",
  "description": "一个新用户下单成功后，订单恰好 1 条、库存归 0。正确实现退出码 0。",
  "app": "my-app",
  "seed": 7,
  "roles": [
    { "id": "buyer", "account": { "username": "buyer_rc", "password": "pw-buyer" }, "seedRole": "none" }
  ],
  "steps": [
    { "id": "register", "actor": "buyer", "op": "register", "params": { "username": "buyer_rc", "password": "pw-buyer" } },
    { "id": "login", "actor": "buyer", "op": "login", "params": { "username": "buyer_rc", "password": "pw-buyer" } },
    { "id": "open", "actor": "buyer", "op": "navigate", "params": { "path": "/buy?sku=sku-1" } },
    { "id": "submit", "actor": "buyer", "op": "submit" }
  ],
  "observers": [
    { "id": "order-count", "sql": "SELECT COUNT(*) AS n FROM orders", "tables": ["orders"], "expectColumns": ["n"] }
  ],
  "assertions": [
    { "id": "exactly-one-order", "rule": "order-recorded", "observer": "order-count", "op": "eq", "value": 1 }
  ],
  "rules": [
    { "id": "order-recorded", "description": "下单落库：orders 恰好 1 条" }
  ]
}
```

跑起来：

```bash
npm run build
node packages/cli/dist/src/main.js check scenarios/my-app-normal.json   # 结构 + 能力检查，不启动应用
node packages/cli/dist/src/main.js run   scenarios/my-app-normal.json --verbose
```

---

## 2. 字段速查

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `protocol.scenario` | ✅ | `"1.1"`（当前）或 `"1.0"`（旧文档仍可执行）；其它值在运行前拒绝（exit 64） |
| `steps[].when` | ❌ | 条件步骤，**需要 1.1**（见 §4.4）；1.0 文档里出现会被拒绝 |
| `steps[].retry` | ❌ | 有界重试（见 §4.3），1.0/1.1 都可用 |
| `id` / `name` / `description` | ✅ | `id` 用于 `plan` 的关键词匹配与报告标题；`description` 会进报告，**把判定口径写清楚** |
| `app` | ✅ | 自由文本，仅作说明与报告展示（真正被测入口来自 `.reality-check.json` 的 `app.entry`） |
| `seed` | ✅ | 非负整数；`rerun` 用同种子重建初始状态 |
| `roles[]` | ✅ ≥1 | `id`（步骤里的 `actor`）、`account{username,password}`、`seedRole`、可选 `attrs` |
| `steps[]` | ✅ ≥1 | 见 §4 |
| `observers[]` | ✅ ≥1 | 见 §5 |
| `assertions[]` | ✅ ≥1 | 见 §5 |
| `rules[]` | ✅ ≥1 | 业务规则；`assertion.rule` 必须在此声明，报告按规则聚合 |

**`seedRole`（规则 7）**：`"holder"` 表示该角色**占用一个初始名额**，由内核在**启动应用时**连同角色声明交给适配器兑现（fixture 走 `RC_SEED`）。不要再用「显式报名步骤」去代替它——那是同一意图的第二次表达，holder 会占两个名额，正确实现反而被判违规。

`seedRole` 取值：`holder`（占用初始名额）/ `none`（只有账号）/ `waitlisted`（进候补队列）。

---

## 3. 步骤 op 语义

| op | 参数 | 语义 | 失败形态 |
| --- | --- | --- | --- |
| `navigate` | `path` | 打开应用内相对路径 | 打不开 → `error` |
| `register` / `login` | `username` / `password` | 走应用的真实表单 | 明确被拒（如「密码错误」）→ `rejected` |
| `fill` | `selector` / `value` | 填输入框 | 选择器不存在 → `error` |
| `click` | `selector`（默认主提交按钮） | 点击；**未触发导航必须如实报失败** | 未导航 → `no-nav` |
| `submit` | — | 提交当前页面的原生表单（POST + 绝对 URL） | 未导航 → `no-nav` |
| `wait` | `ms` | 显式等待 | — |
| `barrier` | — | 与相邻 barrier 步骤组成并发组（见 §6） | 组内各自报结果 |

三种 outcome 的判定后果**完全不同**，这是本项目最重要的一条区分：

| outcome | 含义 | 内核如何判 |
| --- | --- | --- |
| `completed` | 动作执行完成 | 继续 |
| `rejected` / `no-nav` | 应用对**已执行**动作的诚实回答（业务信息） | 照常进入断言 |
| `error` | 这一步**根本没执行**（选择器不存在、导航超时、浏览器断开） | **整轮判 blocked（exit 3）**，并点名步骤 |
| `skipped` | 条件步骤的 `when` 不成立，**故意不执行**（场景 1.1） | 既非失败也非通过；留在时间线与报告里，判定仍由断言承担 |

> 为什么 `error` 必须判 blocked：此时断言是在「未被触碰的状态」上求值，极端情况下初始状态恰好满足期望就会**假通过**——那是对一次并未发生的运行下结论（方案 §3.3 规则 17）。

---

## 4. 三种时序表达

### 4.1 线性（默认）
按 `steps` 数组顺序执行，逐个角色各自独立的浏览器上下文（多账号隔离）。

### 4.2 并行争抢（`barrier`）
相邻的 `barrier: true` 步骤组成一个并发组，由适配器**同时提交**，用于「争抢最后一个名额」这类同步屏障：

```json
{ "id": "c1-submit", "actor": "c1", "op": "submit", "barrier": true },
{ "id": "c2-submit", "actor": "c2", "op": "submit", "barrier": true }
```

组内每个步骤各产生一个 Attempt（顺序与输入一致；内核会校验这一点，少一个或顺序不对即判 `blocked` 并点名——否则后续断言就是在「那一步没发生」的状态上求值）。

**诚实边界（重要）**：适配器保证的是「预热完成后**同一刻**发起提交」，**不是**「两笔写入真的同时落库」。它先把组内每个提交预热到可点（建页、等控件可见），再在同一个 tick 里连续派发点击；每次点击仍会各自做一次快速的可点性复查，网络往返也不受控。所以偏移被**压小**而不是被消除——每个 Attempt 的 `detail.fireOffsetMs` 记录了它相对本组派发时刻的偏移，**这场争抢是否真的发生是可以查的**，不靠相信注释。

并发场景请保留重复实验的习惯：单次结果只说明「这次是这样」。

### 4.3 有界重试（`retry`）
只用于吸收**基础设施抖动**（浏览器断开、瞬时超时），不是用来掩盖业务缺陷：

```json
{ "id": "cancel", "actor": "holder", "op": "submit", "retry": { "attempts": 2, "on": ["error"] } }
```

- `attempts`（1–5，超过在运行前拒绝）；`on` 默认 `["error"]`，可显式列出 `error`/`rejected`/`no-nav`/`completed`。
- **每次尝试都留在时间线里**（`step-retry` 事件，含那次尝试的证据条数），该步骤的 Attempt 记录 `attemptIndex` 与被测时长；最终结论由**最后一次**尝试决定。
- 因此重试可以让一次抖动变成 blocked 之外的成功，但**永远不会**把业务失败洗成通过（`rejected` 默认不触发重试）。
- **已派发的写操作不许重放**：重试是「重放整个步骤」。对 `submit` 这类写动作，如果这一笔**已经发出去**、只是结果读不回来，再点一次就是**第二笔业务写入**——而那正是「允许重复提交」的应用最容易被推过断言线的地方。适配器据实上报 `attempt.detail.dispatched`（只有明确指向「还没轮到点击」的等待超时才报 `false`），内核遇到 `dispatched: true` 就**不重试**，并写一条 `step-retry-refused` 事件说明原因；`dispatched: false`（例如等待元素超时，什么都没发出去）照旧重试。
- `barrier` + `retry` 同时声明会被拒绝：并发组没有「逐步骤重试」的语义。

### 4.4 条件步骤 `when`（场景 1.1，已实现）

```json
{ "id": "late-nav-book", "actor": "late", "op": "navigate", "params": { "path": "/book?course=course-1" },
  "when": { "observer": "capacity-left", "op": "gt", "value": 0 } }
```

语义（方案 §3.3 规则 22）：

- 条件在**该步执行前**求值：内核用 `observe()` 读一次**已声明的观察器**（保持单一口径），并用与断言**完全相同的比较词汇**判定（`eqStr` 用 `expected`，其余用 `value`）。
- 条件成立 ⇒ 照常执行该步；条件不成立 ⇒ 该步**不执行**，记为 `skipped`：既不是失败也不是通过，会出现在时间线（`when` 事件 + `step` 事件的 `outcome: skipped`）、`--verbose` 的步骤表、以及 `explainResult()` 的提示里。判定仍然只由断言承担。
- 条件**无法判定**（观察器 0 行/列缺失/证据引用核对失败）⇒ 整轮判 `blocked`（exit 3），**不猜分支**：在证据不足时替用户选一条路，等于伪造结论。
- 条件引用的观察器必须已声明；`when` 与 `barrier` 不能同步骤（并发组没有逐步骤条件语义）；`when` 需要场景声明 `1.1`（1.0 文档里使用会被校验器与内核两道拒绝）。
- 条件的观察证据同样过「采集即落盘 + 内核逐条核对」的闸门，判定依据可回溯。

完整示例见仓库里的 `scenarios/booking-conditional-skip.json`：两个 holder 占满容量后，一个「仅在还有名额时才报名」的步骤条件不成立 ⇒ 跳过，`bookings` 保持 2 条、退出码 0。

---

## 5. 观察器与断言

观察器 = 「用 SQL 直接读业务真相」，断言 = 「读出来的值必须满足什么」。

```json
"observers": [
  { "id": "capacity-left",
    "sql": "SELECT capacity - (SELECT COUNT(*) FROM bookings WHERE bookings.course_id = courses.id) AS left FROM courses WHERE id = 'course-1'",
    "tables": ["courses", "bookings"],
    "expectColumns": ["left"] }
],
"assertions": [
  { "id": "no-overbooking", "rule": "capacity-not-exceeded", "observer": "capacity-left", "op": "gte", "value": 0 }
]
```

硬约束（写错就在 `check`/运行前被拒，exit 64）：

1. **观察器必须来自适配器清单**，且 `sql` 与清单里的 SQL **逐字同源**（只容忍空白差异）——这条叫「单一口径」，避免报告展示一条查询、判定用另一条。
2. `tables` 必须在适配器 `observedTables` 白名单内；`expectColumns` 必须在清单声明的列内。
3. `assertion.rule` 必须在 `rules` 里声明；`observer` 必须存在。

断言 op：

| op | 用途 | 备注 |
| --- | --- | --- |
| `eq` `ne` `gt` `gte` `lt` `lte` `countEq` | 数值比较 | 主体是观察器第一列；`countEq` 比较**行数** |
| `eqStr` | 字符串等值（如「递补给了哪个账号」） | 用 `expected`（禁写 `value`）；缺失单元格按证据不足处理 |

证据不足（观察器 0 行、列缺失、非数值单元格、证据引用核对失败）时，该断言判 `inconclusive` 并列出缺哪类证据——**不会**算作通过，也不会伪装成违规。

---

## 6. 常见坑（都真实踩过）

1. **相对 action URL**：会被解析到页面路径前缀下变成 404 → 用绝对 URL（适配器已按此实现）。
2. **`fetch + preventDefault` 提交**：「点击完成」早于「服务端处理完成」，采样读到旧值，会把测试自身的时序问题伪装成业务缺陷。
3. **`holder` 既要声明 `seedRole` 又写报名步骤**：会占两个名额（规则 7）。
4. **观察器 SQL 自己重写一遍**：单一口径拒绝（`check` 就报错）。
5. **候补队列顺序只用一个候补者验证**：单元素队列下「队首递补」与「队尾递补」状态同构，无法区分 → 至少两个候补者 + `eqStr`。
6. **只断言存在性、不断言守恒**：`COUNT(*) >= 1` 抓不住超订 → 同时断言「数量正好」和「剩余不为负」。
7. **指望步骤证据参与判定**：步骤截图/DOM 快照只证明「这一步真的发生过」，判定主体永远是观察器 SQL。
8. **把环境问题当业务缺陷**：`blocked`（exit 3）是「环境/工具失败，不构成业务结论」；看到 3 先去修环境（`--verbose` 会直接告诉你哪一步、什么原因）。

---

## 7. 判定与退出码

| 退出码 | verdict | 含义 |
| --- | --- | --- |
| 0 | `passed` | 全部断言在完整证据上成立 |
| 1 | `failed` | 存在证据完整的业务违规 |
| 2 | `inconclusive` | 证据不完整（列出缺失类型），违规降级 |
| 3 | `blocked` | 环境/能力缺失、步骤无法执行、数据根无所有权标记 —— **不含业务结论** |
| 64 | — | 配置非法（场景不合法、单一口径违反、能力缺失），**运行前**拒绝 |
| 70 | — | 工具自身异常 |

`run`/`rerun` 在非 passed/failed 时会把原因打印出来（blocked 阶段 + 具体错误 + 建议、inconclusive 缺哪类证据、产物路径）。`--verbose` 会实时打印每一步与耗时。

---

## 8. 调试套路

```bash
node packages/cli/dist/src/main.js check scenarios/x.json          # 最快的结构/能力反馈
node packages/cli/dist/src/main.js run  scenarios/x.json --verbose # 实时步骤 + 耗时 + 最慢步骤
node packages/cli/dist/src/main.js run  scenarios/x.json --fault overbooking  # 故障注入
node packages/cli/dist/src/main.js rerun --run-id <runId>          # 同种子复跑（修完应用再跑）
node packages/cli/dist/src/main.js export                          # 历史运行与复跑命令
```

产物在 `runs/<runId>/`：`result.json`（判定 + 证据引用）、`events.jsonl`（时间线，`seq` 是唯一顺序）、`report.html`、`evidence/`（截图/DOM/观察器 SQL 结果）、`data/ownership.json`（数据根所有权台账）。
