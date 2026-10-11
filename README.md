# Reality Check

面向 localhost 项目的本地业务演练工具：描述业务规则并接入本地项目后，让一组有前后关系的业务事件**真实作用于应用**（真实 Chromium、真实表单提交、服务端写库），记录证据、检查规则，并在修复后以相同种子复跑验证。完整工程路线见 [Reality-Check-工程阶段方案.md](./Reality-Check-工程阶段方案.md)。

## 仓库结构

```
packages/
  protocol          六套版本化协议（场景/结果/适配清单/适配接口/运行产物/工具）
  core              执行内核：所有权台账、能力门禁、断言求值、四类裁决
  adapter-local-web Playwright 驱动的本地 Web 适配器（证据落盘、SQL 观察器）
  planner           受限模型规划器（needsModel + 四类回退，无自由脚本执行）
  reporter          JSON/HTML 报告
  cli               reality-check 命令行（check/run/rerun/export/plan）
  workbench         本地工作台 Web UI（复用同一执行内核与结果协议）
  mcp-server        MCP stdio 服务（check/run/get_result/rerun，供编程助手调用）
  adapter-sdk       适配器 SDK + 一致性测试套件（外部适配器作者入口）
fixtures/
  booking-app       参考应用：课程报名（正确版 + 三个故障开关）
  exam-seat-app     第二独立应用：考试座位预约（不同域模型）
scenarios/          三个基准场景 JSON
scripts/            阶段验收脚本（稳定性、blocked 用例）
```

## 快速开始

```bash
npm install
npm run build

# 结构校验 + 适配器能力检查（不启动应用）
node packages/cli/dist/src/main.js check scenarios/booking-normal.json

# 真实执行：浏览器操作 → 服务端写库 → 独立 SQL 观察 → 断言 → 报告
node packages/cli/dist/src/main.js run scenarios/booking-contend.json

# 故障注入：--fault overbooking | cancel-keeps-slot | waitlist-order-wrong
node packages/cli/dist/src/main.js run scenarios/booking-contend.json --fault overbooking

# 同种子复跑、导出历史、自然语言选场景
node packages/cli/dist/src/main.js rerun --run-id <runId>
node packages/cli/dist/src/main.js export
node packages/cli/dist/src/main.js plan "帮我测一下争抢最后一个名额"

# 脱敏证据包：把一次运行的结论与取证链导出成可分享的包（账号/密钥/内部路径被替换，
# 导出后独立反扫，任何残留都拒绝产出；二进制截图默认排除并写明原因）
node packages/cli/dist/src/main.js export --run-id <runId> --pack <dir> [--include-images]

# --verbose：实时打印每步结果与耗时，并给出最慢步骤（哪一步慢/卡住一眼看到）
node packages/cli/dist/src/main.js run scenarios/booking-normal.json --verbose
```

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [docs/scenario-guide.md](./docs/scenario-guide.md) | 写场景的人 | 场景结构、字段速查、op 语义、判定后果、并行/有界重试、常见坑、条件分支设计草案 |
| [docs/protocol-reference.md](./docs/protocol-reference.md) | 想核对契约的人 | 六套协议的字段与不变量、磁盘布局、兼容性策略（1.0 内扩展 vs 需升版） |
| [docs/adapter-tutorial.md](./docs/adapter-tutorial.md) | 接自己项目的人 | 从零写适配器：manifest → setupEnv(roles) → 步骤/证据 → observe → teardown → 一致性套件 → 排查表 |
| [docs/adapter-sdk.md](./docs/adapter-sdk.md) | 适配器作者 | 契约规范与能力声明要求（教程里引用的「规范」） |
| [Reality-Check-工程阶段方案.md](./Reality-Check-工程阶段方案.md) | 评审者 | 工程路线、不可后补的约束、§12 完成判据、附录 A 实测证据 |
| [docs/接入耗时记录.md](./docs/接入耗时记录.md) | 接入者 | 第二个独立应用仅凭文档接入的耗时与逐条阻碍 |
| [docs/体检报告-2026-10-10.md](./docs/体检报告-2026-10-10.md) | 评审者 | 代码/逻辑/功能/需求四维体检：评级、缺陷修复史、工程债、风险清单与建议 |
| [docs/审查与修复报告-2026-10-11.md](./docs/审查与修复报告-2026-10-11.md) | 评审者 | 七轮/八轮共 13 条缺陷的证据与修复、5 条被推翻的候选、自检清单与诚实边界 |

## 工作台与 MCP

```bash
# 本地工作台（http://127.0.0.1:7788）：场景管理、参数化重演、时间线回看、草案生成
node packages/workbench/dist/src/main.js

# MCP stdio 服务（四工具：rc_check / rc_run / rc_get_result / rc_rerun）
node packages/mcp-server/dist/src/main.js

# 适配器一致性测试（外部适配器作者，见 docs/adapter-sdk.md）
node -e "import('@rc/adapter-sdk').then(async m => console.log(await m.runConformanceSuite(m.createLocalWebAdapter({appPath:'fixtures/booking-app/server.js'}), {appPath:'fixtures/booking-app/server.js', workDir: '.sdk-work'})))"
```

## 验收脚本

```bash
# 正反例配对矩阵：6 场景 check + 两应用正确实现 + 四个故障开关 + rerun（判据 = 退出码 + 归因规则）
node scripts/positive-negative-matrix.mjs

# 三入口一致性：CLI / 工作台 HTTP / MCP stdio 跑同一场景，逐字段比对 result.json
node scripts/tri-entry-consistency.mjs

# 诊断能力基准：跑前冻结的 12 例标注案例集，统计漏报/误报并公开样本
node scripts/diagnostic-benchmark.mjs

# 外部助手闭环：仅用 MCP 公开接口 + 一次应用文本编辑（读失败 → 改应用 → 复验）
node scripts/external-agent-loop.mjs

# 环境缺失路径（退出码 3）与串行 10 次稳定性
node scripts/blocked-case.mjs
node scripts/serial-stability.mjs

# 一键跑完上面全部门禁（顺序执行、任一失败即整体失败；--no-serial 跳过最慢的 10 连跑）
npm run accept        # 完整
npm run accept:fast   # 跳过串行稳定性
```

## 退出码契约

| 退出码 | 含义 |
|---|---|
| 0 | passed：全部断言在完整证据上成立 |
| 1 | failed：至少一条规则**被证伪**（该规则自身证据完整）。同轮里另一条断言读空不会把已证实的失败降级 |
| 2 | inconclusive：没有规则被证伪，但至少一条判定不了（列出缺失证据类型） |
| 3 | blocked：环境或能力缺失，不构成业务结论 |
| 64 | 配置非法（运行前拒绝） |
| 70 | 工具自身异常（**结论已落盘后的呈现失败不算**——见下） |

> **结论与呈现分离**：内核先把结论写进 `result.json`，之后 CLI/工作台再写侧车与报告。这一步失败（磁盘只读、目录被换掉、`events.jsonl` 单行损坏）**不改退出码**，而是把原因以 `warning:` 打到 stderr：一次真实的 `failed`（exit 1）不能因为 HTML 没写出来就变成 exit 70，否则 CI 会把真实回归当成环境抖动。

## 核心约束（不可后补）

- **数据隔离**：只初始化/重置工具创建并记录所有权的资源；已有内容但无所有权标记的数据根目录拒绝运行。
- **业务真相**：断言主体只走场景声明的观察器 SQL；观察器每次读取新建连接（WAL 可见性靠独立连接，不靠只读标志）。
- **证据**：适配器采集即落盘，内核**逐条核对**它接受的证据引用（在本次运行的 `evidence/` 内、非空、sha256 与登记值一致）——**观察器证据与每步截图/DOM 快照走同一道闸门**（`attempts[].evidence`）。核对失败的引用被剔除并具名；观察器证据失败会把引用它的断言降级为 inconclusive（`evidence-file`），步骤证据不是断言主体、只作「这一步真的发生过」的凭据。缺失证据类型是封闭集合，校验器拒收无法归类的字符串。
- **单一口径**：场景 observer 的 SQL 必须与适配器清单 SQL 一致（仅容忍空白差异），差异即配置错误（exit 64），拒绝发生在创建运行目录之前。
- **观察器属于应用，且必须是只读语句**：清单来自应用旁的 `reality-check.observers.json`（或配置 `adapter.observers`）；`sql` 必须是**单条** `SELECT`/`WITH`——SQLite 的 `prepare("INSERT …").all()` 返回 `[]` 却真的写入，运行中改写被测应用等于伪造结论；表/列名必须是纯标识符（被拼进 dump 语句）。应用入口存在却没有任何声明 ⇒ 具名配置错误（不会静默回退到 fixture 预设，同名表会查出别的意思）；入口不存在 ⇒ 环境缺失，保持 `blocked`。
- **所有权**：内核在启动应用前认领数据根（`data/ownership.json`）；已有内容而无所有权标记 → blocked；应用库（`EnvSummary.dbPath`）登记进台账，`teardown` 由台账兜底清理，只清理 `ownedBy === runId` 的资源；适配器另拒绝已存在的 db 文件。
- **角色声明**：场景角色的 `seedRole`（`holder` 占用初始名额）由内核在启动时交给适配器兑现——`registerAccounts` 之后无法追溯占位（规则 7）。
- **模型边界**：无类别线索返回 `needsModel`；模型不可用/超时/预算耗尽/未知场景一律回退已保存场景。**没有类别线索且无可用模型时不选任何场景**（不猜默认），`plan` 在此情形下退出码 0 并如实打印，而空场景目录是配置错误（exit 64）；全程不执行自由生成的脚本。
- **步骤执行失败 ≠ 业务结论**：任何一步 `outcome=error`（导航/点击根本没执行）一律判 `blocked`（exit 3）并在 `blocked` 事件里点名步骤——否则断言是在「未被触碰的状态」上求值，极端情况下会假通过。`rejected` / `no-nav` 是应用对已执行步骤的诚实回答，属业务信息，照常进入断言。
- **条件步骤（场景 1.1）**：`steps[].when` 引用**已声明观察器**，用与断言同一套比较词汇判定；条件不成立 ⇒ 该步记 `skipped`（既非失败也非通过，留在时间线与报告里）；条件**无法判定**（观察器读不到**或证据核验失败**）⇒ 整轮 `blocked`，绝不替用户猜一条分支。1.0 文档不得使用 `when`（校验器与内核两道拒绝）。
- **重放已派发的写操作 = 第二笔业务写入**：`retry` 的语义是重放整个步骤。若一次 `submit` 已经发出去、只是结果读不回来，适配器报 `detail.dispatched: true`，内核**拒绝重放**并写一条 `step-retry-refused` 事件——只有「什么都没发出去」（等待元素超时）才允许重试。判据是**有没有派发**，不是「是不是 submit」：后者会把为 Chromium 偶发断开加的重试一并废掉。
- **并发组的契约**：`barrier` 组内每个步骤一个 Attempt、顺序与输入一致（内核**自校验**，不符即 `blocked` 并点名）；争抢的诚实性是「同一刻发起」而非「同时落库」——每步记录 `detail.fireOffsetMs`，偏移可查；同一 actor 只建一个浏览器上下文（并发建页单次飞行）。
- **协议版本**：场景/结果为 1.1（内核同时接受 1.0 场景，语义不变）；适配器清单必须声明覆盖当前版本，不匹配在运行前拒绝（exit 64）。升版模板见 `docs/protocol-reference.md` §6。
- **可归因的基础设施失败**：适配器监听浏览器断开、检查页面是否已被关闭，把原因写进 `attempt.detail.error`（而不是抛出一句无从下手的 Playwright 错误）；不做自动恢复——重建上下文会丢登录会话，硬造成功比失败更危险。
- **脱敏证据包**：`export --run-id <id> --pack <dir>` 产出可分享的运行包——已知敏感值（场景角色账号/密码、db 绝对路径、运行目录）逐字替换 + 显式模式规则（账号名/路径/端口/邮箱/密钥/私钥）兜底；写完**独立反扫**，任何原始敏感值残留都会删掉整包并报错（exit 70）；二进制截图默认排除（像素擦不掉，不假装脱敏），`--include-images` 显式包含时标记 `sanitized: false`。
