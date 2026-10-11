# Reality Check：完整工程路线

日期：2026-09-28（本文取代 2026-09-22 版「工程阶段方案」）  
定位：面向 localhost 项目的本地业务演练工具。  
当前状态（2026-10-10）：**阶段 0–1 ✅ 已实现并验收；阶段 2–3 功能已实现但仅 ◐（取证项未完成）；阶段 4 ◐ 核心已实现**。v0.1.0 已打标签；本轮收口的改动、缺陷与实测证据见附录 A.6。下文各阶段正文保留原定义与审查方法。

---

## 0. 本文的状态标记与审查约定

本文所有断言分为三档，不许混用：

| 标记 | 含义 | 证据要求 |
| --- | --- | --- |
| ✅ 已验证 | 在本机真实运行过并留有产物 | 有退出码、结论行、测试计数或运行目录可查 |
| ◐ 部分完成 | 实现了但有明确缺口 | 缺口逐条列出，不模糊化 |
| ⬜ 未开始 | 只有定义，没有实现 | 不做任何完成暗示 |

**审查的通用方法**（适用于每个阶段，阶段章节里不再重复）：

1. **正反例配对**：任何「工具能发现 X」的主张，必须同时验证「正确实现下不误报」与「故障实现下必报对」。只演示反例不算验证——误报和漏报要一起测。
2. **三层验证链**：单元测试（模块内）→ 模块测试（跨包接口）→ 真实浏览器端到端验收（Chromium 驱动真实应用、独立查库断言）。第三层不可被前两层替代。
3. **退出码即契约**：验收看退出码 + 结论行 + 违规归因到具体规则，不看日志里「大概是对的」。
4. **证据可落盘**：报告里每个证据引用必须对应运行目录内的真实文件；适配器没写文件就返回引用的，一律视为工具缺陷（我们在阶段 0 调试中真实踩过并修掉这个坑）。

---

## 1. 产品承诺

开发者描述产品规则并接入本地项目后，工具让一组有前后关系的业务事件实际作用于应用，记录证据、检查规则，并在修复后重新运行相同场景。

第一版服务报名／预约类 Web 应用。核心价值是验证具体业务过程及其结果。工具不预测真实用户需求，不证明线上可靠，也不承诺自动理解任意仓库。

首个对外版本必须满足：能够由文档接入第二个独立项目，不需要修改执行内核；不能只在自带示例中成立。**这条是 MVP 的定义性门槛，不是加分项。**

## 2. 第一版产品边界

| 项目 | MVP 决策 |
| --- | --- |
| 使用地点 | localhost 和用户明确配置的隔离测试环境 |
| 应用类型 | 有名额限制、取消和候补规则的报名／预约应用 |
| 参考项目 | Node.js/TypeScript/SQLite（HTTP+表单）；Next.js 适配器列入阶段 1 收尾 |
| 浏览器 | Chromium（Playwright） |
| 用户界面 | CLI 加可本地打开的 HTML 报告 |
| 首批场景 | 正常报名、争抢最后名额、取消后的候补递补 |
| 大模型 | 从已支持场景中选择、填写参数、解释证据；不自由生成并执行任意脚本 |
| 初始数据 | 由工具创建的测试账号和业务数据，每次运行可重新初始化 |
| 外部服务 | MVP 不包含真实支付、真实邮件、任意第三方服务接管 |
| 重放含义 | 重新建立初始状态，运行相同场景；不是任意时刻恢复整个应用 |
| 首发系统 | Windows 与 Linux；macOS 支持经实际验证后列入矩阵 |

## 3. 当前状态总览（2026-10-10 六轮更新：阶段 0–1 ✅；阶段 2–3 实体建成但仅 ◐（取证项未完成）；阶段 4 ◐ 部分实现。多维度体检见 `docs/体检报告-2026-10-10.md`）

### 3.1 已建成并实测 ✅

- **Monorepo 结构**：`packages/protocol`（版本化协议：场景 1.0 / 结果 1.0 / 适配清单 1.0 / 适配接口 1.0 / 运行产物 1.0 / 工具 0.1.0）、`packages/core`（执行内核）、`packages/adapter-local-web`（本地 Web+SQLite 适配器）、`packages/planner`（受限模型规划器）、`packages/reporter`（HTML/JSON 报告）、`packages/cli`（check/run/rerun/export/plan 五命令）、`packages/workbench`（本地工作台）、`packages/mcp-server`（MCP stdio 服务）、`packages/adapter-sdk`（适配器 SDK + 一致性套件）、`fixtures/booking-app` 与 `fixtures/exam-seat-app`（两个独立参考应用，正确版 + 三个可单独启用的故障版）。
- **三个基准场景全部端到端跑通**：真实 Chromium → 真实表单提交 → 服务端写库 → 独立 SQL 观察 → 断言 → HTML/JSON 报告。
- **正反例配对实测矩阵**（Windows 本机，2026-09-23 记录）：

| 场景 | 正确实现 | overbooking 故障 | cancel-keeps-slot 故障 | waitlist-order-wrong 故障 |
| --- | --- | --- | --- | --- |
| 正常报名 | 退出码 0，通过 | — | — | — |
| 争抢最后名额 | 退出码 0，通过 | 退出码 1，✗ capacity-not-exceeded；✓ every-attempt-recorded 不受牵连 | — | — |
| 取消候补递补 | 退出码 0，5/5 断言通过 | — | 退出码 1，✗ cancel-releases-slot、✗ waitlist-declared-order（3 断言失败） | 退出码 1，✗ waitlist-declared-order（4 断言通过不受牵连） |

- **CLI 五命令**：`check`（结构校验+能力检查，六场景全过）、`run`、`rerun --run-id`（同种子重建环境重跑，实测正确版本重跑仍通过）、`export`（列出历史运行及复跑命令）、`plan`（受限规划器；无线索且无可用模型时不选任何场景，空场景目录为配置错误）。
- **测试**：**148 项全过（2026-10-10 五轮 `npm run verify` 实测；首轮基线为 103 项中 99 通过 / 4 失败）**。五轮新增 `scenario 1.1 when` 校验（协议层）、条件步骤四种分支（内核层：成立/不成立/无法判定/barrier 拒绝）等分组。新增测试文件与分组：`packages/core/test/engine-evidence.test.ts`（伪适配器跨包测试：单一口径 SQL 校验、证据引用核对与降级、角色声明传递、步骤证据登记与剔除、数据根台账与兜底清理、blocked 不抛异常）、`packages/protocol/test/result.test.ts`（缺失证据类型封闭集合 + `Attempt.evidence` 校验器测试）、`packages/core/test/artifacts.test.ts` 新增 `RunArtifacts.verifyEvidenceRef` 分组、`packages/adapter-local-web/test/adapter.test.ts` 新增「拒绝非本次运行所有的 db」「证据采集失败必须留痕」「每个步骤交回可核对证据引用」三项。
- **退出码契约实测**：0（通过）、1（业务违规）、2（证据不完整降级）、3（blocked，`scripts/blocked-case.mjs` PASS）、64（配置非法，含 BOM JSON 被拒、空场景目录的 `plan`）、70（工具自身异常）。
- **正反例配对矩阵已脚本化（2026-10-10）**：`scripts/positive-negative-matrix.mjs` 一条命令跑完 19 个用例（6 场景 `check` + booking/exam 正确实现 + 四个故障开关 + `rerun`），实测 19/19 退出码与归因规则一致，见附录 A.6。
- **内核级保证（2026-10-10 两轮累计）**：内核逐条核对适配器交回的证据引用（存在性 + 哈希 + 路径），观察器证据失败即降级 inconclusive 并具名 `evidence-file`，步骤证据失败即剔除并具名；场景观察器 SQL 与适配器清单 SQL 必须同源（单一口径，仅空白差异被容忍）；适配器拒绝使用不属于本次运行的 db 文件；内核在启动前认领数据根并把应用库登记进台账；场景声明的 `seedRole` 由内核交给 `setupEnv` 真实兑现（见 §3.3 规则 11–16）。
- **三入口一致性（2026-10-10 二轮）**：`scripts/tri-entry-consistency.mjs` 以真实进程分别经 CLI / 工作台 HTTP / MCP stdio 跑同一场景，逐字段比对三份 `result.json`（排除 runId、时间戳、端口、绝对路径），实测一致。

### 3.2 阶段 1 收尾任务 ✅ 已全部完成（证据见附录 A.2）

1. **第二个独立应用接入**（不修改执行内核；不能是参考应用换皮）。
2. **串行稳定性**：固定数据场景连续 10 次运行结论一致。
3. **Linux 安装运行导出验证**（Windows 已验证）。
4. **blocked 路径（退出码 3）的专门验收用例**；以及 30 分钟接入耗时的实测记录。

### 3.3 已沉淀、不可回退的工程决策 ✅

这些是阶段 0/1 调试中用真实故障换来的规则，后续阶段不得违反（详见第 11 节）：

1. **独立状态观察器每次读取都新建连接再关闭**：被测应用在另一进程以 WAL 模式写入；长持连接会停在旧快照，`readOnly: true` 标志则根本看不到 WAL 内容。独立性靠「独立连接 + SQL 层只读白名单」，不靠 SQLite 只读标志。
2. **断言主体读取必须复用场景声明的观察器 SQL**：不允许在适配器里另写一条「等价查询」——两套口径会让报告展示值与判定依据互相矛盾。
3. **证据由适配器落盘、内核核对**：适配器采集后立即写进运行目录，`EvidenceStore` 登记时验证文件存在；不存在即报错，绝不用占位内容伪造证据。
4. **证据完整性按「要求的类型逐项」核对**，不按数量：少采一类多采一类时按数量算会误判为完整。
5. **表单提交用原生 POST + 绝对 URL**：相对 action 会被解析到页面路径前缀下变成 404；`fetch + preventDefault` 会让「点击完成」早于「服务端处理完成」，采样读到旧值——测试自己的时序问题会伪装成业务缺陷。
6. **点击未触发导航必须如实报失败**，不能静默成功让断言背锅。
7. **场景角色必须先注册为应用账号**；是否**占用**初始名额由 `seedRole: "holder"` 显式声明——把所有角色默认当持有者会让「要新报名的人」被拒，正确实现反被误报（我们实测踩过）。**声明的兑现必须发生在应用启动前**：内核把场景角色交给 `setupEnv`（`registerAccounts` 之后再建账号已无法追溯占位）。此条在 2026-10-10 之前只是文档约定、内核并未传参，场景只能用显式报名步骤代替；现已在第二轮落地，6 个场景同步改为声明式。
8. **所有权台账拒绝重复登记**：同一资源登记两次直接中断，掩盖所有权错误的代码不允许跑。
9. **规划器没有类别线索时返回 `needsModel` 而不是猜默认场景**；模型不可用/超时/预算耗尽/返回未知场景 id 一律回退到已保存场景，不向上抛异常。
10. **端到端测试并行时必须分配独立端口**：共用端口会让一个测试的浏览器打到另一个测试的应用上，结论变成噪声。
11. **内核必须逐条核对它接受的每一条证据引用**（2026-10-10 补）：核对文件存在、非空、在本运行 `evidence/` 内、sha256 与登记值一致；核对失败的引用从结果中剔除，引用它的断言降级为 inconclusive 并具名 `evidence-file`。此前只核对"引用是否被声明"，无法阻止伪造引用。
12. **场景观察器 SQL 与适配器清单 SQL 必须同源，由内核在校验阶段比对**（§3.3 规则 2 早已声明，「单一口径」的内核校验在 2026-10-10 才真正落地）：只容忍空白差异，任何实质差异（列、表、WHERE）都是配置错误（exit 64），且拒绝发生在创建运行目录之前。归一化必须按空白 `\s+` 处理——写错字符类会让检查静默失效（本轮真实踩过，见附录 A.6）。
13. **适配器拒绝使用不属于本次运行的 db 文件**（2026-10-10 补）：目标路径已存在 db 文件即拒绝启动，内核转成 blocked（exit 3），绝不静默复用残留数据。缺少这一步时，`claimDataRoot` 的 §10 数据隔离在此路径上无人执行（见附录 A.5 限制 5）。
14. **`missingEvidenceTypes` 是封闭集合，不是 `string[]`**（2026-10-10 补）：证据缺口必须能归因到具体类型，结果校验器拒收无法归类的字符串，防止用占位值糊过校验。
15. **步骤证据与观察器证据走同一道核对闸门**（2026-10-10 二轮）：`Attempt.evidence` 由适配器采集并落盘，内核逐条核对（在本次运行的 `evidence/` 内、非空、sha256 一致）后才写进 `result.json`；核对失败的引用被剔除并在时间线具名。步骤证据**不是断言主体**——它证明「这一步真的发生过」，不改变判定。
16. **内核在启动应用之前认领数据根**（2026-10-10 二轮）：`claimDataRoot(runDir/data, runId)` 写 `ownership.json`；已有内容而无所有权标记 → blocked（exit 3，绝不冒充业务结论）。适配器在 `EnvSummary.dbPath` 报告的应用库会被登记进台账，`teardown` 后由台账做第二道清理兜底。此前 `claimDataRoot` 只被单测调用，产品路径无人执行。
17. **步骤「执行失败」不是业务结论**（2026-10-10 三轮，基准实测逼出来的）：`Attempt.outcome === "error"` 意味着这一步根本没发生，此时的业务断言在**未被触碰的状态**上求值，甚至可能因初始状态恰好满足期望而报 `passed`——那是对一次并未发生的运行下结论。因此任何 error 步骤一律 blocked（exit 3）并在 `blocked` 事件里列出步骤 id；而 `rejected` / `no-nav` 是应用对**已执行**步骤的诚实回答，属于业务信息，照常进入断言（规则 6）。
18. **基础设施失败必须可归因**（2026-10-10 三轮）：Chromium 中途断开（实测 12 连跑中偶发 1 次）此前只会表现为一句 `page.goto: Target page, context or browser has been closed`，无法与场景缺陷区分。现在适配器监听 `disconnected`、检查 `page.isClosed()`，并把原因写进 `attempt.detail.error`（「Chromium disconnected mid-run … 环境/工具失败」）；同时用启动参数抑制后台页节流。**不做**自动恢复：重建上下文会丢登录会话，硬造成功比失败更危险。
19. **重试是有界的、可见的、只吸收基础设施抖动**（2026-10-10 四轮）：`step.retry = { attempts: 1..5, on?: AttemptOutcome[] }`，默认只在 `error` 上重试；每次尝试都以 `step-retry` 事件留在时间线里，该步骤的 Attempt 记录 `attemptIndex` 与被测时长，判定由**最后一次**尝试决定。因此重试能把一次抖动变成成功，**永远不能**把业务失败洗成通过（`rejected`/`no-nav` 需显式写进 `on` 才会重试，而默认不写）。`barrier` + `retry` 同步骤声明在运行前拒绝——并发组没有「逐步骤重试」的语义。
20. **报错必须自证**（2026-10-10 四轮）：非 passed/failed 的结论一律把「为什么」打印出来——blocked 的阶段、原始错误、无法执行的步骤 id 与建议；inconclusive 缺哪一类证据；并给出产物绝对路径。措辞由 protocol 的 `explainResult()` 单点提供，CLI 与 MCP 共用，避免各处口径不一。
21. **可观测性靠事件流，不靠猜**（2026-10-10 四轮）：内核把每个 Attempt 的耗时写进 `durationMs`（含 barrier 组），并支持 `onEvent` 实时回调；CLI `--verbose` 因此能边跑边打印步骤/观察/重试，结束后给出最慢三步。时间线仍是唯一真相来源（`seq` 排序），实时流只是它的镜像。
22. **条件步骤：跳过是记录，不是结论**（2026-10-10 五轮，场景/结果升版 1.0 → 1.1）：`steps[].when` 只能引用**已声明观察器**，用与断言同一套词汇判定；条件不成立 ⇒ 该步 `skipped`（不执行、不进 blocked、也不当成功，必须留在时间线与报告里）；条件**无法判定**（观察器 0 行/列缺失/证据核对失败）⇒ 整轮 blocked——在证据不足时替用户选分支等于伪造结论。`when` + `barrier` 同步骤拒绝；`when` 出现在 1.0 文档被校验器与内核**两道**拒绝。升版按 `docs/protocol-reference.md` §6 的模板执行，并重跑全部证据链。
23. **脱敏导出宁可拒产，不可漏检**（2026-10-10 六轮）：`export --run-id <id> --pack <dir>` 产出可分享的证据包。三层防线：①已知敏感值（场景角色账号/密码、db 绝对路径、运行目录）**逐字**替换，长值优先；②显式模式规则兜底（`_rc` 账号、Windows/POSIX 绝对路径、回环端口、邮箱、API key、Bearer、PEM 私钥）；③写完后**独立反扫**——包内任一文本文件再出现任何原始敏感值即删除整包、exit 70。二进制截图**默认排除**（像素无法用文本规则擦除，不假装脱敏），`--include-images` 显式包含时在 pack.json 标记 `sanitized: false`。规则表与反扫实现在 `packages/reporter/src/sanitize.ts` 单一来源，CLI/MCP/工作台可复用。
24. **已证实的违规不被不相干的证据缺口压低**（2026-10-11 七轮）：结果聚合是「任意一条 violated ⇒ failed（exit 1）」；只有当**没有**规则被证伪、却有判定不了的断言时才是 inconclusive（exit 2）。旧规则「有 inconclusive 一律 inconclusive」会把一次真实超订（该规则证据完整）因为另一个观察器恰好读空而报成 exit 2——把真失败降了一档。缺口仍在其自身规则上具名（`missingEvidenceTypes`）并留在报告里，只是不再覆盖别人的结论。受此影响，`cancel-keeps-slot/-seat` 两个冻结标签由 2 重冻结为 1（理由写入 `fixtures/diagnostic-cases.json` 的 `revisions`）。
25. **观察器属于应用，不属于适配器源码**（2026-10-11 七轮）：适配器里不再硬编码任何业务主键/账号（曾经的 `course-1`/`exam-1`/`holder_rc` 现在只是**两个自带参考应用的预设**）。接入新应用只写配置：应用目录旁的 `reality-check.observers.json`、配置里的 `adapter.observers`，或直接传 `observers`。`observedTables` 随之声明；声明的表不在白名单内、缺少 sql/columns、JSON 坏掉都按**配置错误**具名拒绝（exit 64），绝不静默回退到预设（回退会让同名表查出别的意思）。「单一口径」不变：场景 observer 的 SQL 仍必须与适配器清单一致，只是清单现在来自应用配置。
26. **报告里的 `expected` 必须按 op 的词汇渲染**（2026-10-11 七轮）：`eqStr` 带 `expected`、数值 op 带 `value`，曾共用 `${op} ${value}` 模板，导致 eqStr 一旦 inconclusive 就渲染成 `eqStr undefined`——最关键的一句恰好在最需要它时消失。现在 held/violated/inconclusive/not-evaluated 四种判定共用同一个 `expectedText()`。顺带放开断言与条件的**负值**（`value` 不再 `min: 0`）：余额透支、库存缺口、超订后 `capacity-left = -1` 正是断言存在的理由。
27. **基础设施失败必须落到数据里，不能抛出调用栈**（2026-10-11 七轮）：fixture 子进程的 `spawn` 失败曾写成 `child.on("error", () => { throw err })`——该回调不在任何调用栈内，throw 会变成未捕获异常：进程直接死，没有 `blocked` 事件、没有 `result.json`，与「可归因的基础设施失败」的承诺正好相反（浏览器断开这条处理得很好，唯独子进程漏了）。现在错误被记录，健康检查循环把它转成 `setupEnv` 的正常拒绝（内核 ⇒ blocked / exit 3），运行期再出现则写进 `attempt.detail.error`。
28. **只读是语句性质，不是表名性质**（2026-10-11 八轮）：规则 1 的白名单只校验「SQL 里出现了哪些表」，不校验「这条 SQL 干什么」。而观察器口径自规则 25 起已从适配器源码变成**应用配置**——信任边界变宽了。实测 `node:sqlite` 的 `prepare("INSERT INTO t VALUES(1)").all()` 返回 `[]` 却**真的写入**（多语句 `;` 同样被接受），也就是说一条写语句会在运行中静默改写被测应用的状态，等于伪造结论。现在观察器 SQL 必须是**单条** `SELECT`/`WITH`（去掉注释后判定，`;` 一律拒绝），运行前再验一次；`tables`/`columns`/`observedTables` 必须是纯 SQL 标识符（它们被拼进 dump 语句，不是参数绑定）。违规是**具名配置错误**（exit 64）。
29. **缺声明与缺应用是两类缺失**（2026-10-11 八轮）：应用入口存在却没有任何观察器声明 ⇒ 配置错误（exit 64，附上该怎么做的具体提示），因为静默回退到 fixture 预设会让第三方应用的**同名表**用别人的口径（`course-1`、`holder_rc`）得出一个看起来完全正常的错误结论；应用入口**不存在** ⇒ 环境缺失，运行本会以 `blocked` 结束，观察器根本用不上，此时提前判配置错误会把 `blocked` 变成 exit 64、掩盖「应用没搭起来」这个真正原因。两个自带参考应用各自随目录提供 `reality-check.observers.json`，测试钉住它们与预设常量一致（防漂移）。
30. **结论与呈现分离：呈现失败不得顶掉结论**（2026-10-11 八轮）：内核已经把结论写进 `result.json`，所以 CLI/工作台写侧车与报告失败时**不抛异常、不改退出码**，而是把原因写进 `warning` 并打到 stderr。此前 `readEvents`/报告写入的任何异常都会变成 exit 70：一次真实的 `failed`（exit 1）在 CI 上被报成工具错误，真实回归会被当成环境抖动。`events.jsonl` 单行损坏也只降级为一条 warning。
31. **用户给的标识符先验形状，再拼路径**（2026-10-11 八轮）：`runId` 来自命令行参数或 MCP 工具调用，随后被 `path.join` 到 `runsDir`；在 `export --pack` 里那个路径还会被**递归删除**后重写——`..` 在那里不是笔误，是破坏性路径穿越。MCP 侧早有守卫，CLI 侧没有。现在 `runIdProblem()`/`isSafeRunId()` 落在 `@rc/protocol` 单一来源，CLI `export`/`rerun`/`pack` 与 MCP 共用；工作台对非法 `seed`/`fault` 返回 400 而不是静默按默认值跑（用户拿到 200 + verdict 会以为那是「指定种子下的结论」）。MCP 的进程级异常处理还会**终结在途请求**（`failInFlight`）：请求是串行队列，一个永不 settle 的 promise 会让包括 `ping` 在内的后续请求全部挂死，服务器活着但不回答比报错更难排查。
32. **重放已派发的写操作 = 第二笔业务写入**（2026-10-11 九轮）：`retry` 的语义是**重放整个步骤**。对一个写入动作（`submit`）来说，只有「这次尝试什么都没发出去」时重放才是安全的；如果提交已经发出、只是读不回结果，再点一次就是第二次写入——而那正是「允许重复提交」的应用（本工具要抓的对象）最容易被推过断言线的地方。判据落在**事实**上：适配器在 `attempt.detail.dispatched` 里报告是否已派发（只有明确指向「还没轮到点击」的等待超时才报 false），内核拒绝重放已派发的写入并写一条 `step-retry-refused` 事件说明原因。**不能**简单禁止 `submit` + `retry`——那正是第三轮为 Chromium 偶发断开刻意加的缓解，一律禁止会把真实抖动重新变成 blocked。
33. **并发组的结果必须与输入逐一对上**（2026-10-11 九轮）：适配器契约要求 `runBarrier` 「每个步骤一个 Attempt，按输入顺序」。内核此前**只遍历返回的数组**，从不比对：少返回一个步骤，那个步骤就既没执行、也不会被「步骤 error ⇒ blocked」的门禁抓到，随后的断言会在**这一步没发生**的状态上求值——典型的假通过。现在内核自己校验条数与顺序（一致性套件查的是适配器，内核不能把契约当前提），不符即 blocked 并点名。
34. **争抢是「同刻发起」，不是「证明同时落库」**（2026-10-11 九轮）：`runBarrier` 先把组内每个提交**预热**（建页、等控件可见可点）完成，再在**同一个 tick** 里连续派发全部点击——偏移被压小，但没有被消除（每次点击仍各自做一次可点性复查，网络往返也不受控）。因此每个 Attempt 记下 `detail.fireOffsetMs`：**「这场争抢是否真的发生」是可以查的**，不靠相信注释。另外建页在并发下改为**单次飞行**（同一 actor 只建一个 context）：原先 `get` 与 `set` 之间隔着 `await`，并发调用会各建一个 context、后者覆盖前者——泄漏一个 context，而且两步跑在两页上、证据只取「最后写入」的那页。
35. **条件步骤与断言共用同一把尺**（2026-10-11 九轮）：`when` 的条件判定走的是与断言同一套词汇，但**证据核验**这条曾漏掉：正式观察路径在证据引用核验失败时会降级（`evidence-file`），条件路径却把 `validRefs` 收下、继续用原始 `reading` 判定——于是证据文件被破坏时条件仍可能判 `held` 并**执行一步本不该发生的业务动作**。现在两条路径同一口径：核验失败 ⇒ 条件无法判定 ⇒ blocked（规则 22），不替用户选分支。

## 4. 阶段 0：工程基线 —— ✅ 已完成并验收

### 做到什么程度

- 统一命令：构建、类型检查、全仓测试；TypeScript 全仓严格模式（含 `exactOptionalPropertyTypes`）。
- 有版本号的场景描述、适配接口、事件格式、结果格式；接口版本不匹配在运行前拒绝。
- 参考报名应用：正确实现 + 三个故障开关（`overbooking` / `cancel-keeps-slot` / `waitlist-order-wrong`），经环境变量单独启用。
- 初始数据、账号、数据库创建与**所有权清理**协议：只清理台账内 `ownedBy === runId` 的资源。

### 怎么审查

- 跑全仓测试（当前 91 项）与全量类型检查。
- 用 3.1 节的正反例矩阵复核：正确版本全过、每个故障版本被归因到**对应的**规则。
- 抽查运行目录：`data/ownership.json` 是本次运行对数据根的台账（`runId`/`dataRoot`/`entries`）；`torn-down` 事件同时记录适配器清理的路径与台账 `{entries, removed}`（`entries` = 本运行登记的资源数，`removed` = 台账实际兜底删掉的路径，适配器已清理则为空）；`evidence/` 内文件与 `result.json` 的 `evidence[]`/`attempts[].evidence[]` 引用一一对应。

### 验收合格判定（全部已达成 ✅）

- 独立状态读取（SQL，不走被测应用接口）确认正确与故障版本产生**不同**业务结果。
- 场景格式不合法、缺必要观察能力时**运行前**报错（实测含 BOM JSON 被拒）。
- 每次运行独立数据；中断后的残留不会成为下次起点（数据根目录含所有权标记校验）。
- 结论语义四分类落地：通过/违规/未完成/证据不足各自有独立退出码路径。

## 5. 阶段 1：v0.1 MVP —— ✅ 已完成并验收（含四项收尾，见附录 A.2）

### 用户路径（已可走通 ✅）

1. 在符合支持条件的项目中初始化配置，`check` 检查接入能力。
2. 选择已有场景（受限模型规划器可辅助选择与参数化）。
3. 工具创建隔离环境与账号，启动真实浏览器执行。
4. 得到 HTML 与 JSON 报告。
5. 修改应用后 `rerun --run-id` 同条件重新执行，比较业务结果。

报告必须包含：业务规则、实验条件、实际观察、结果类别、操作与请求时间线、截图/快照证据、复跑入口。（已实测输出以上全部。）

### 已实现 ✅

场景校验与能力检查；真实浏览器操作与多账号隔离；独立业务状态观察与断言；同步屏障（争抢场景两个角色同时提交）；环境生命周期与所有权清理；有界模型调用（结构化输出、超时、预算、四类回退）；HTML/JSON 报告。

### 收尾任务与验收标准 ⬜

| 任务 | 做到什么程度 | 审查方法 | 合格判定 |
| --- | --- | --- | --- |
| 第二独立应用接入 | 仅凭文档+适配层接入，不改执行内核 | 全程记录耗时与每处阻碍 | 3 类场景在新应用上可运行、检查、复跑；内核零改动 |
| 串行稳定性 | 固定数据场景连跑 10 次 | 脚本循环执行，收集退出码 | 10/10 结论一致；不一致必须归因（环境/时序）并记录 |
| Linux 验证 | 真实 Linux 机器 `npm install && npm run verify` | 安装、运行、报告导出各跑一遍 | 与 Windows 行为一致，退出码语义相同 |
| blocked 验收 | 人为制造环境缺失（如占用端口、删数据库目录） | 观察 `run` 的退出码 3 与结论行 | 环境问题被明确标为 blocked，不冒充业务缺陷也不假装通过 |
| 接入耗时记录 | 第二项目接入实测计时 | 如实记录 | 以 30 分钟为初始体验目标，达标与否都写进发布说明 |

**达标后发布 v0.1。若第二项目要求改内核：先修抽象，再扩界面——这是既定顺序，不因时间压力调换。**

## 6. 阶段 2：v0.2 本地演练工作台 —— ◐ 功能已实现并实测（packages/workbench，见附录 A.3）；「验收合格判定」后两项（≥3 个不同项目试用、预先标注案例集评估）无取证，故不标 ✅

### 做到什么程度

- 本地页面管理项目、规则、场景和运行记录；查看事件时间线与角色视角观察。
- 修改人数、角色、顺序等参数重新演练；查看失败规则与代码、请求、状态变化的证据关联。
- 从需求/README/选定源码生成规则与场景**草案**。

### 怎么审查

- 工作台必须复用同一执行内核与结果协议：用同一场景分别从 CLI 和工作台跑，结果逐字段一致。
- 模型生成物全部过结构校验+能力检查，被拒时给出可修的错误；注入式攻击用例（在自然语言里诱导生成脚本）必须被拒。
- 代码位置只能来自堆栈、source map、适配记录或可核验源码引用；模型凭空生成的定位必须在评审中被打回。
- 时间线回看标注「历史观察」，重新执行标注「新运行」，两者 UI 上不可混淆。

### 验收合格判定

- 大模型无法绕过能力限制执行未约束脚本。
- 每项「已验证问题」可回溯到对应运行证据；假设与已证实事实分开显示。
- 模型不可用时已有场景仍可执行并出客观报告。
- ≥3 个不同项目试用，记录接入耗时、有效发现、误报率、再次使用情况。
- 诊断能力用预先标注的正常/故障案例集评估，公开案例范围，不用自评代替。

## 7. 阶段 3：v0.3 开发工作流 —— ◐ MCP 服务与 CI 工作流已实现并实测（packages/mcp-server + .github/workflows/ci.yml，见附录 A.3）；「三入口差异比对脚本、CI 实际跑绿记录、未参与开发的助手闭环」三项无取证，故不标 ✅

### 做到什么程度

- MCP 服务：编程助手可检查项目、提出场景、运行、读结果、复验。
- CI：指定提交上运行固定回归集；每次运行比较修复前后同一规则。
- 团队共享场景与脱敏证据包。

### 怎么审查

- 同一配置经 CLI、MCP、CI 三入口运行，规则与结果语义一致（用差异测试脚本比对 `result.json`）。
- CI 每轮从干净环境开始：连续两轮 CI，第二轮的账号/数据不受第一轮影响。
- 故意制造环境启动失败与观察能力缺失，确认 CI 不把它们计为产品 bug，也不假装通过。
- 让一个**未参与开发的**编程助手仅靠公开接口完成「读取失败 → 修改应用 → 复验」闭环。

### 验收合格判定

- 固定场景可离线执行；CI 默认不依赖在线模型。
- 退出码三态（通过/业务失败/未完成）在 CI 消费方可直接使用。
- 记录并展示代码版本、场景版本、适配器版本、环境摘要。
- 修复建议与源码修改解耦：工具只提供证据与验证结果。

## 8. 阶段 4：v1.0 可扩展工具 —— ◐ 核心已实现（packages/adapter-sdk + 一致性套件）；受控事件注入、虚拟时间、macOS 支持未开始

### 做到什么程度

- 适配器 SDK、能力声明与一致性测试套件；外部开发者可独立发布和验证适配器。
- 报名/预约之外的第二类业务（如团队协作）；受控事件注入（模拟邮件、回调）；虚拟时间仅用于明确接入时钟的组件。
- 稳定安装、升级、迁移、排障、兼容性说明。

### 怎么审查

- 外部贡献者**仅凭 SDK 和文档**（不看内核源码）完成一个适配器并通过一致性测试。
- 场景/适配器/报告的版本兼容有自动化验证：故意用旧版本场景跑新内核，行为符合声明的兼容规则。
- 证据包脱敏检查：导出包内不得残留账号、密钥、内部路径。

### 验收合格判定

- 新业务场景不需要重写执行内核。
- 不兼容变更有明确迁移路径。
- 公布支持范围、已验证场景、误报样本、接入限制与复现成功情况。
- **复用检验**：现有用户在后续修改/发布前会再次运行工具。若没有重复使用，优先解决价值与接入成本，不继续扩大平台范围。

## 9. 固定架构

```text
自然语言／已保存场景
          ↓
大模型规划器（可选，四类回退）
          ↓
有版本的场景描述 → 结构校验 → 适配能力检查
          ↓
隔离环境 + 执行内核 + 观察接口（独立连接读库）
          ↓
结构化事件 + 可执行断言 + 落盘证据
          ↓
JSON／HTML 报告
          ↓
CLI（已有）／工作台／MCP／CI
```

模块（已建成）：`protocol`、`core`、`adapter-local-web`、`planner`、`reporter`、`cli`、`fixtures/booking-app`。工作台和 MCP 随阶段添加。首版用文件保存场景与证据；查询规模确有需要才引入索引数据库；不引入微服务、消息队列、云账号体系。

## 10. 不能后补的工程约束

**数据隔离**：localhost 不代表数据库是测试数据库。只初始化/重置工具创建并记录所有权的资源；数据根目录等于/包含应用根目录、已有内容但无所有权标记时拒绝运行。清理只作用于台账内资源，重复登记直接中断。

**结果语义**：`passed`（断言成立）／`failed`（有完整证据的业务违规）／`blocked`（环境或能力缺失）／`inconclusive`（证据不足）。成功页面、HTTP 200、无 console error 都不能证明业务成功；证据不完整时违反也降级为 inconclusive，并**列出缺哪些证据类型**。

**业务真相**：断言主体必须走场景声明的观察器 SQL（单一口径）；观察器每次读取新建连接；页面文字与应用自报接口只作线索展示，不参与判定。

**证据**：适配器采集即落盘于运行目录；内核登记时核对文件存在；完整性按要求的类型逐项核对。`seq` 单调递增是唯一排序依据；时间相邻只是线索，`causationId` 才是因果边。

**大模型边界**：输出过校验、调用有超时与预算；无类别线索时标记 `needsModel` 而非猜默认；模型全程不可用时已保存场景照常执行。

**复跑**：保存场景、种子、应用版本、适配器版本、环境摘要、操作顺序、同步点、故障条件。相同场景可重复执行 ≠ 整个应用确定；并发场景保留重复实验与违规频次记录。

## 11. 实施顺序与下一步

阶段 0 已完成。阶段 1 收尾按此顺序执行：

1. blocked 路径验收用例（小，先把退出码契约补全）。
2. 串行 10 次稳定性（纯执行，无开发量）。
3. **第二独立应用接入**（最大风险项，可能暴露抽象缺口，早做）。
4. Linux 验证 + 接入耗时记录 → 发布 v0.1。

时间不足时推迟工作台、源码深度诊断、自动扩展场景、MCP 与更多业务类型；**数据隔离、正反例配对、第二项目接入、复跑能力永不裁剪**。

首个版本的完成定义：用户能在支持范围内接入自己的项目，运行明确业务场景，拿到可信证据，并在修复后重新验证。

### 11.1 本轮收口（2026-10-10，已完成）

上一轮结束时工作区有 13 个文件、+223/-123 的未提交改动，全部触及 §10 不可后补条款，却零新增核心测试、无实测证据；`npm test` 实测 103 项中 4 项失败。本轮按「缺陷 → 类型契约 → 退出码契约 → 复核 → 测试 → 实测 → 文档」收口，证据见附录 A.6。**结论：阶段 0/1 维持 ✅；阶段 2/3 由 ✅ 回退为 ◐；阶段 4 维持 ◐**——标 ✅ 所需的取证尚未完成，不能用「功能已写好」代替验收。

### 11.2 下一步排队（顺序即优先级；数据隔离、正反例配对、第二项目接入、复跑能力永不裁剪）

**已完成（2026-10-10 二轮收口，证据见 A.7）**

- **三入口一致性**：`scripts/tri-entry-consistency.mjs`（CLI / 工作台 / MCP 各自真实进程，逐字段比对 `result.json`）实测一致；CI 已加入该步骤与矩阵步骤（托管 Runner 的运行号仍待补）。
- **步骤证据登记与核对**：`Attempt.evidence` 与观察器证据走同一道核对闸门 —— A.5 限制 4 关闭。
- **`claimDataRoot` 接进产品路径**：内核启动前认领数据根、登记应用库、`teardown` 由台账兜底 —— A.5 限制 5 关闭。
- **规则 7 落地**：内核向 `setupEnv` 传角色声明，6 个场景改为声明式占位 —— A.5 限制 1 关闭。

**P1 — 剩余取证项（在此完成前不开新功能）**

1. **CI 托管 Runner 实跑绿的记录**：工作流已覆盖全部门禁且可手动触发（`workflow_dispatch`），差的是**跑一次并把运行号写进附录 A**（本机 7/7 ≠ CI 7/7）。
2. **≥3 个真实外部项目试用**（当前只有两个自带 fixture）：记录接入耗时、有效发现、误报率、再次使用情况；需要外部输入，无法自证。
3. ~~场景条件分支（`when`）~~ —— **已完成（五轮）**：场景/结果升版 1.1，语义与边界见规则 22、`docs/scenario-guide.md` §4.4、`docs/protocol-reference.md` §6；示例场景 + 矩阵 + 标注案例集同步（A.10）。
3. ~~预先标注的正常/故障案例集评估~~ —— **已完成**：`fixtures/diagnostic-cases.json` + `scripts/diagnostic-benchmark.mjs`，12/12、漏报 0、误报 0（A.8，含一处标签修正的公开）。
4. ~~未参与开发的编程助手闭环~~ —— **已完成**：`scripts/external-agent-loop.mjs`（仅 MCP 公开接口 + 一次应用文本编辑，A.8）。

**P2 — 阶段 4 剩余（P1 完成后再开工）**

- 受控事件注入（模拟邮件/回调）、虚拟时间（仅限显式接入时钟的组件）、macOS 入矩阵、场景/适配器版本兼容自动化验证（旧场景跑新内核）、安装/升级/迁移/排障文档。~~证据包脱敏检查~~ —— **已完成（六轮）**：`export --run-id <id> --pack <dir>`，语义见规则 23、证据见 A.11。

**已知基础设施风险（不是业务结论问题，但影响可用性）**

- Chromium 在连续多次运行中偶发中途断开（2026-10-10 观测：一次 12 连跑中出现 1 次，单独重复 6 次为 0 次）。已做两件事：① 步骤执行失败一律判 blocked（绝不产出业务结论，见 §3.3 规则 17），② 加启动参数抑制后台页节流 + `disconnected` 监听，使失败**可归因**（`attempt.detail.error` 直接写「Chromium disconnected mid-run」）。仍未做：浏览器崩溃后的自动恢复（会丢失登录会话，属于独立课题），因此该风险以「blocked + 明确原因」暴露，而非静默降级。

---

## 12. 「完美」的判据（完成定义，可逐条检验）

本项目里「完美」不是「功能都写好了」，而是下面这张表**全部为 ✅ 且证据可复现**（一条命令 `npm run accept` 即可重跑绝大多数项）。任何一行是 ◐/⬜，「完美」就不成立——这一点不由自评决定，由证据决定。

| # | 判据（可检验） | 现状 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 全仓绿色门禁：typecheck + build + 单测全过（含真实 Chromium 端到端） | ✅ | `npm run verify` = **195/195**；**`npm run accept` 一键 7/7 一次性跑通**（2026-10-11 九轮，见 A.12/A.14/A.15） |
| 2 | 正反例配对：正确实现不误报、每个故障开关被归因到**对应**规则 | ✅ | `node scripts/positive-negative-matrix.mjs` 19/19，0 偏差 |
| 3 | 诊断能力用**预先标注**案例集评估，公开范围与误报样本 | ✅ | `fixtures/diagnostic-cases.json`（12 例，跑前冻结）+ `scripts/diagnostic-benchmark.mjs`：12/12，漏报 0、误报 0 |
| 4 | 三入口（CLI / 工作台 / MCP）结果语义逐字段一致 | ✅ | `scripts/tri-entry-consistency.mjs`：三份 `result.json` 无差异 |
| 5 | 未参与开发的助手仅靠公开接口走通「读失败 → 改应用 → 复验」 | ✅ | `scripts/external-agent-loop.mjs`：failed → 文本编辑应用副本 → rerun passed（故障开关全程未变） |
| 6 | 环境/工具失败不冒充业务结论（blocked 路径） | ✅ | `scripts/blocked-case.mjs` PASS；步骤执行失败亦判 blocked（规则 17） |
| 7 | 复跑稳定：固定场景连续 10 次结论一致 | ✅ | `scripts/serial-stability.mjs` 10/10 |
| 8 | 第二个独立应用仅凭文档接入且内核零改动；30 分钟接入耗时 | ✅ | `docs/接入耗时记录.md`；本轮因规则 7 落地使接入更简单（声明式占位） |
| 9 | 证据链闭环：采集即落盘 → 内核逐条核对 → 报告可回溯 | ✅ | 观察器证据与步骤证据同闸门；`result.json.evidence` 与 `evidence/` 一一对应（A.7） |
| 10 | 数据隔离：只清理台账内资源；无标记数据根拒绝运行 | ✅ | 内核启动前 `claimDataRoot` + 台账兜底清理（A.7）；适配器拒绝非本次运行的 db |
| 11 | Linux 行为与 Windows 一致 | ◐ | WSL2 记录在 A.2；本轮新增的步骤证据/台账未在 Linux 复跑 |
| 12 | CI 在托管 Runner 上真正跑绿（含三入口与矩阵） | ◐ | 工作流已覆盖 `npm run accept` 的全部门禁（build+test、三入口、矩阵、基准、闭环、blocked、串行）并支持 `workflow_dispatch` 手动触发；**仍缺 GitHub Runner 的运行号**（本机 7/7 不能代替 CI 7/7） |
| 13 | ≥3 个**真实外部项目**试用，记录耗时/发现/误报/复用 | ⬜ | 仓库内只有 2 个自带 fixture；需要外部输入，无法自证 |
| 14 | macOS 支持经实际验证后入矩阵 | ⬜ | 需要 macOS 机器 |
| 15 | 受控事件注入（邮件/回调）、虚拟时间、安装/升级/迁移/排障文档 | ⬜ | 阶段 4 未开工的明确范围 |
| 20 | 证据包脱敏导出：账号/密钥/内部路径不得残留，导出后独立反扫 | ✅ | `export --run-id <id> --pack <dir>`（规则 23）；单测 14 项 + 真实运行导出实测：12 文件、74 处替换、4 个二进制排除、leak scan clean，包内反扫零残留（A.11） |
| 21 | 观察器口径随应用走 + 只读是语句性质 + 入口标识符先验形状 + 呈现失败不顶掉结论 | ✅ | 规则 28–31；`fixtures/<app>/reality-check.observers.json` × 2（测试钉住与预设一致）；`npm run verify` 187/187（A.14） |
| 22 | 内核并发段：重放已派发的写、并发组结果不校验、条件证据不核验、建页竞态、争抢未真正同刻 | ✅ | 规则 32–35；`npm run verify` 195/195、`accept` 7/7；真实争抢运行 `fireOffsetMs=2ms`（A.15） |
| 16 | 面向使用者的文档：场景编写指南、协议字段速查、适配器开发教程 | ✅ | `docs/scenario-guide.md`、`docs/protocol-reference.md`、`docs/adapter-tutorial.md`（README 有索引） |
| 17 | 报错具象化：blocked/inconclusive 直接说明原因与建议、给出产物路径 | ✅ | protocol `explainResult()` 单点措辞，CLI 与 MCP 共用；cli 测试断言 blocked 输出含阶段/原因/建议/路径 |
| 18 | 运行时可观测性：实时步骤流 + 每步耗时 + 最慢步骤 | ✅ | 内核 `Attempt.durationMs` + `onEvent` 流；`run/rerun --verbose` 实测边跑边打印并给出 slowest |
| 19 | 场景表达力：并行争抢（barrier）、有界重试（retry）、条件步骤（when） | ✅ | barrier 早已支持；retry 见规则 19；`when` 于五轮随场景/结果 **1.0 → 1.1 升版**落地（规则 22，语义：不成立 ⇒ skipped、无法判定 ⇒ blocked），示例场景 `booking-conditional-skip` 纳入矩阵与标注案例集 |

**结论（诚实版）**：1–10 已达「可复现的证据链」标准；11–12 缺环境/托管运行号；13–15 缺**外部输入**（外部项目、macOS、阶段 4 功能）——这些不是再写几行代码就能变绿的，所以「完美」在当前能力边界内 = 「1–10 持续为 ✅ 且任何一次改动都重跑全链」，而 13–15 属于需要你提供资源才能推进的项。

---

## 附录 A：验收证据（2026-09-29 与 2026-10-10 实测记录，✅ 均有运行目录/退出码可查）

### A.1 阶段 0/1：正反例矩阵（退出码即契约）

| 场景 | 正确实现 | overbooking | cancel-keeps-slot(-seat) | waitlist-order-wrong |
| --- | --- | --- | --- | --- |
| booking-normal | 退出码 0，通过 | — | — | — |
| booking-contend | 退出码 0，通过 | 退出码 1，✗ capacity-not-exceeded；✓ booking-recorded 不受牵连 | — | — |
| booking-cancel-waitlist | 退出码 0，3 断言全过 | — | 退出码 1，✗cancel-releases-slot、✗waitlist-declared-order（另有一条 inconclusive 具名 `rows`，按规则 24 不再压低结论；2026-10-11 前记为 2） | 退出码 1，✗waitlist-declared-order ×2；✓cancel-releases-slot 不受牵连 |
| exam-normal | 退出码 0，通过 | — | — | — |
| exam-contend | 退出码 0，通过 | 退出码 1，✗capacity-not-exceeded | — | — |
| exam-cancel-waitlist | 退出码 0，3 断言全过 | — | 退出码 1，✗ 两规则（2026-10-11 前记为 2，同规则 24） | 退出码 1，✗waitlist-declared-order |

要点：候补顺序故障的检出依赖 `eqStr` 断言（协议 1.0 扩展，op+expected 交叉校验）与**两个候补者**（bob 队首、carol 队尾）——单候补队列下首位/末位递补状态同构，无法区分。booking 侧曾因场景步骤排序错误（carol 报名排在取消之后）导致故障无法区分，经时间线证据定位后修正。

2026-10-10：上表已脚本化为 `scripts/positive-negative-matrix.mjs`（一条命令跑完 6 个 `check` + 各应用正确实现 + 四个故障开关 + `rerun`，判据为退出码 + 归因规则），实测 19/19 一致，见 A.6。矩阵中 `cancel-keeps-slot(-seat)` 一列两个应用均为退出码 2（证据缺失降级），与本文旧版 3.1 节表格中的「退出码 1」不一致——以 A.6 的实测为准。

### A.2 阶段 1 收尾四项

1. **blocked（退出码 3）**：config 指向不存在应用入口 → exit 3、verdict=blocked、规则全部 not-evaluated（scripts/blocked-case.mjs，三项检查 PASS）。
2. **串行稳定性**：booking-normal 连续 10 次运行，10/10 退出码 0（scripts/serial-stability.mjs）。
3. **第二独立应用接入**：exam-seat-app 三场景 check/run/rerun 全通；接入耗时 2–17 分钟（<30 分钟目标）；**内核零改动**（docs/接入耗时记录.md 有逐条阻碍记录）。
4. **Linux 验证**：WSL2 Ubuntu（Node 22）npm install/build/test 99+ 项全过；CLI run/rerun/export 行为与 Windows 一致（含 overbooking 故障归因一致）。Chromium 系统库以无 root 方案（deb 本地解包 + LD_LIBRARY_PATH）补齐，已记录于 .wsl-setup.sh。

### A.3 阶段 2–4

- **工作台**：同一场景经工作台 API 与 CLI 运行，verdict/结果协议块/场景哈希逐字段一致；注入式草案请求被 422 拒绝；15/15 测试。
- **MCP**：stdio 四工具（check/run/get_result/rerun）；blocked 以正常结果返回（exit 3）而非错误；恶意输入后循环存活；2/2 黑盒测试。
- **CI**：GitHub Actions 双 OS 矩阵 + clean-env-twice（连续两轮）工作流就绪（.github/workflows/ci.yml）。
- **适配器 SDK**：一致性套件 6/6 检查通过（清单合法、环境生命周期、证据落盘哈希、新鲜连接观察、屏障声明诚实性、所有权清理）；伪造证据的反例被正确打回；外部作者指南 docs/adapter-sdk.md。

### A.4 全仓测试

- 2026-09-29（Linux/WSL2）：`npm test` 99+ 项全过（除 adapter-sdk dist 未入 WSL 副本少计 4 项）。
- **2026-10-10（Windows）**：`npm run verify` = typecheck + build + test，**121/121 通过，0 失败**；同一轮修复前的基线为 103 项中 99 通过 / 4 失败（`adapter-local-web` 的 overbooking 故障用例被新的 db 所有权拒绝规则打红；`cli` 的两项 `plan` 断言与新的「不猜默认场景」语义冲突；`workbench` 的草案回退断言与新语义冲突）。

### A.5 已知限制（如实记录，非完成暗示）

1. ~~内核未向 setupEnv 传递 seedRole 种子；角色"占用初始名额"只能由场景**显式报名步骤**代替（规则 7 的完整内核实现列为改进项）。~~ **已于 2026-10-10 二轮修复**：内核把场景角色传给 `setupEnv`，6 个场景改为声明式（见 A.7）。
2. cancel-keeps-slot(-seat) 故障在本 fixture 中为"取消完全无操作"，其中一条断言（递补者的账号名）因观察器读空而判不了（inconclusive，`missingEvidenceTypes:["rows"]`，具名留在报告里）；但同轮另有两条**证据完整**的 violated 规则，按规则 24 整轮为 exit 1（2026-10-11 之前是 exit 2）。
3. macOS 支持未验证（方案 §2 表格约定：经实际验证后列入矩阵）。
4. ~~步骤证据未登记、不参与核对（适配器把每步截图与 DOM 快照写进 `evidence/`，但 `Attempt` 没有证据字段……§10「内核登记时核对文件存在」只覆盖观察器证据）。~~ **已于 2026-10-10 二轮修复**：`Attempt.evidence` 走同一道核对闸门（见 A.7）。边界仍在：步骤证据不是断言主体，其缺失不改变判定。
5. ~~`claimDataRoot` 未接入产品路径（§10「已有内容但无所有权标记的数据根目录拒绝运行」只被 core 单测调用）。~~ **已于 2026-10-10 二轮修复**：内核启动前认领数据根、登记应用库、`teardown` 台账兜底（见 A.7）。
6. 旧文档口径修正：`docs/接入耗时记录.md` 记录的 `exam-cancel-waitlist --fault cancel-keeps-seat` 退出码为 1，2026-10-10 实测为 2（与 A.1/A.6 一致）——该文档已追加更正说明。

### A.6 2026-10-10 收口轮：改动、缺陷与实测证据

**背景**：HEAD(`v0.1.0`) 自称「阶段 0–4 已验收」，但工作区存在 13 个文件、+223/-123 的未提交改动，且无对应测试与实测记录。本轮先建立基线再修复，全部证据如下。

**基线（修复前，2026-10-10）**：`npm run verify` → 103 项测试，99 通过 / 4 失败：

| 失败项 | 根因 | 处置 |
| --- | --- | --- |
| `adapter-local-web`「fault run (overbooking, capacity 0 free)」 | 用例预先手写 `data/app.db` 造"名额已满"，撞上新增的所有权铁律 | 用例改建前置条件走受支持路径：两个 `seedRole:"holder"` 角色占满容量 2（规则 7），断言改为 booking-count=4 / capacity-left=-2；新增「拒绝非本次运行所有的 db」独立用例 |
| `cli`「no category clue…（needs-model）」 | 断言仍期望旧语义 `needsModel=false` + 回退到已保存场景 | 更新为「不选任何场景」：`needsModel=true`、`fallback=needs-model`、输出无 `scenario=` |
| `cli`「no scenarios available at all -> config error (64)」 | 实现在空场景目录时返回 0 | `plan` 恢复两层退出码契约：空场景目录 → 64；有场景但无线索且无模型 → 0 且明确打印「未选择任何场景」 |
| `workbench`「no category clue falls back to a saved scenario」 | 期望 200 + 猜测的草案 | 改为 422 + `rejected:"needs-model"`，并断言不产出任何草案 |

**复核发现并修复的缺陷（review-agent 只读复核，缺陷优先）**：

| 优先级 | 问题 | 修复 |
| --- | --- | --- |
| P0 | `core/src/engine.ts` 的 SQL 归一化正则写成 `/s+/g`（匹配字母 s），「单一口径」检查形同失效，且可能把含 `s` 的 SQL 改坏后**误判为相同** | 改为 `/\s+/g`，补「仅空白差异通过 / 实质差异 configError」双用例 |
| P1 | 证据降级时把已有的更具体缺口（`["rows"]`/`["cell"]`）**覆盖**成 `["evidence-file"]`，丢失真实原因 | 改为并集去重（`Set`），补「两种缺口同时保留」用例 |
| P2 | 适配器注释声称采集失败会被「内核证据核对」接住——步骤证据实际未被内核登记（见 A.5 限制 4） | 注释改为如实描述，并指向 §11.2 排队项 |
| P2 | `missingEvidenceTypes` 被放宽为 `string[]`，校验器用 `vArray(vString)` 放行任意字符串 | 收紧为封闭联合 `MissingEvidenceType`（= `EVIDENCE_KINDS` ∪ 观察缺口 ∪ `"evidence-file"`），validator 改 `vEnum`，删除 `assert.ts` 里的 `as EvidenceKind[]` 强转 |
| P3 | `EvidenceKind` 在 `result.ts` 与 `manifest.ts` 重复定义，易漂移 | `result.ts` 改为从 `EVIDENCE_KINDS` 派生，并补「两个列表不得漂移」的校验器测试 |
| P3 | `engine.ts` 的 `// (b) Capability gate.` 分段注释在改动中被删 | 恢复 |

**协议兼容性决策**：`missingEvidenceTypes` 的收紧是对 result 1.0 合法文档空间的**向后兼容强化**（所有既有生产方只产出这些取值），因此不升版本号；决策与理由记录于此。

**本轮的实现改动（源码）**：

- `packages/protocol/src/result.ts`：新增并导出 `MISSING_EVIDENCE_TYPES` / `MissingEvidenceType`；`RuleEvaluation.missingEvidenceTypes` 收紧；`EvidenceKind` 派生自 `EVIDENCE_KINDS`。
- `packages/core/src/engine.ts`：修正 `normalizeSql`；落地「单一口径」校验（场景 SQL vs 清单 SQL，实质差异 → exit 64，且发生在创建运行目录之前）；观察阶段逐条核对证据引用并把不可用引用降级、具名 `evidence-file`；恢复 `(b)` 分段注释。
- `packages/core/src/artifacts.ts`：新增 `verifyEvidenceRef`（路径逃逸 / 非文件 / 空文件占位 / sha256 不一致 → 具名原因）。
- `packages/core/src/assert.ts`：删除本地重复联合与强转，改用 protocol 的 `MissingEvidenceType`。
- `packages/adapter-local-web/src/adapter.ts`：拒绝已存在的 db 文件（内核转 blocked）；证据采集失败写 `attempt.detail.evidenceError` 并如实注释其可见性边界。
- `packages/cli/src/commands/plan.ts`、`packages/planner/*`、`packages/workbench/src/server.ts`：无线索且无可用模型时**不选任何场景**（`PlanDecision.scenario` 可选、`needsModel=true` 如实输出），并恢复 `plan` 的两层退出码契约。

**新增/更新的测试**：`packages/core/test/engine-evidence.test.ts`（新，伪适配器跨包测试）、`packages/protocol/test/result.test.ts`（新，校验器封闭集合）、`packages/core/test/artifacts.test.ts`（新增 `verifyEvidenceRef` 5 项）、`packages/adapter-local-web/test/adapter.test.ts`（新增 db 所有权拒绝、采集失败留痕）、`packages/cli/test/cli.test.ts`、`packages/workbench/test/workbench.test.ts`（过期断言更新）。

**实测证据（Windows 本机，命令与退出码）**：

| 命令 | 结果 |
| --- | --- |
| `npm run verify` | **121/121 通过**（typecheck + build + test，0 失败） |
| `node scripts/positive-negative-matrix.mjs` | **19/19 一致，0 偏差**；booking-normal `rc-mv26fipv-5e0a6502` → 0；booking-contend → 0；booking-cancel-waitlist → 0；booking-contend+overbooking → 1（✗ capacity-not-exceeded）；booking-cancel-waitlist+cancel-keeps-slot → 2；booking-cancel-waitlist+waitlist-order-wrong → 1；exam 三场景正确实现 → 0；exam-contend+overbooking → 1；exam-cancel-waitlist+cancel-keeps-seat → 2；exam-cancel-waitlist+waitlist-order-wrong → 1；6 个 `check` → 0 |
| `node scripts/blocked-case.mjs` | PASS：exit 3、verdict=blocked、全部规则 not-evaluated（`rc-mv26jwuq-1bed4a6e`） |
| `node scripts/serial-stability.mjs` | 10 次运行 exit codes = [0]，10/10 一致（新增的 db 所有权拒绝规则未干扰复跑） |
| `rerun --run-id rc-mv26fipv-5e0a6502` | 新 `rc-mv26jkx6-41aa4159`，`previous=passed now=passed`，exit 0 |

**诚实边界**：本轮**未**做任何阶段 2/3/4 的取证补齐，也未实现 §11.2 的排队项；因此阶段 2/3 的状态由 ✅ 回退为 ◐，阶段 4 维持 ◐。功能「已写好」不等于「已验收」。

### A.7 2026-10-10 二轮：三处「声明了但没兑现」的修复

**动机**：一轮收口后仍有三处**代码与自身规则不一致**的地方（都属于「文档写了、代码没做」，是最危险的一类不一致）。二轮把它们全部兑现，并重跑全部端到端证据。

| # | 症状（二轮前） | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | `seedRole` 是协议必填字段，但**内核从不把它交给适配器**：`setupEnv` 签名里没有 `roles`，产品路径上 `RC_SEED` 永远是空的，`"holder"` 声明静默无效；6 个场景只能用显式报名步骤代替占位（且场景描述里明写了这个妥协） | 内核向 `setupEnv` 传 `scenario.roles`；`LocalWebAdapterV1` 契约、SDK 一致性套件、`docs/adapter-sdk.md` 同步；6 个场景删除 holder 自报名步骤、描述改为声明式（step 数 8→4 / 12→8 等） | `engine-evidence.test.ts` 断言内核交付 `alice:none / hold_rc:holder / queued_rc:waitlisted`；矩阵 19/19 与之前完全一致（说明语义等价），`workbench` 场景步骤数断言同步更新 |
| 2 | 每步截图/DOM 快照**写盘但从不登记**：`Attempt` 没有证据字段，`result.json.evidence` 里只有 observer 的 `sql-dump`，§10「内核登记时核对文件存在」只覆盖一半证据 | `Attempt.evidence?: EvidenceRef[]`（协议 1.0，validator 同步）；适配器 `captureStepEvidence` 返回引用（**不再抛错**：部分成功也保留已落盘的引用，失败经 `evidenceError` 上报）；内核用同一道 `verifyEvidenceRef` 闸门核对、剔除无效引用并具名；`step` 事件带 `evidence: N` | 真实运行 `rc-mv27i08g-d3b32773`（booking-normal）：`evidence[]` 10 条 = 4 步 ×2（screenshot+dom-snapshot）+ 2 个 observer `sql-dump`；`engine-evidence.test.ts` 覆盖「有效引用登记 + 幽灵引用剔除并具名」 |
| 3 | `claimDataRoot`（§10「已有内容但无所有权标记的数据根拒绝运行」）**只被单测调用**：产品路径上没人认领数据根，也没有 `ownership.json` | 内核在启动应用前 `claimDataRoot(dataRoot, runId)`（失败 → blocked/exit 3），把 `EnvSummary.dbPath` 登记进台账，`teardown` 后由台账兜底清理；`OwnershipRegistry.teardown` 只上报**实际删除**的路径，`torn-down` 事件带 `ownership:{entries,removed}` | `rc-mv27i08g-d3b32773`：`data/ownership.json`（runId/dataRoot/entries=[]）、`data/` 内只剩台账文件（app.db 已被清理）；`engine-evidence.test.ts` 断言 entries=1、removed=[db] |

**二轮实测（Windows 本机，命令与退出码）**：

| 命令 | 结果 |
| --- | --- |
| `npm run verify` | **124/124 通过**（typecheck + build + test，0 失败） |
| `node scripts/positive-negative-matrix.mjs` | **19/19 一致，0 偏差**：booking-normal `rc-mv27jya8-30f551e1` →0；booking-contend+overbooking `rc-mv27klku-34c84332` →1；booking-cancel-waitlist+cancel-keeps-slot `rc-mv27ku5m-6dc59af9` →2；+waitlist-order-wrong `rc-mv27l50a-acc41805` →1；exam-contend+overbooking `rc-mv27m5cf-e2e6a80c` →1；exam-cancel-waitlist+cancel-keeps-seat `rc-mv27mdz3-ac155077` →2；+waitlist-order-wrong `rc-mv27moeg-414a2f46` →1 |
| `node scripts/tri-entry-consistency.mjs`（新增） | **三入口一致**：CLI `rc-mv27jca6-eb66caed` / 工作台 `rc-mv27jhln-cf31695a` / MCP `rc-mv27jm6c-d2dec421`，verdict 全是 passed，`evidence` 10 条、`attempts` 4 条，逐字段比对无差异 |
| `node scripts/blocked-case.mjs` | PASS：exit 3、blocked、全部规则 not-evaluated |
| `node scripts/serial-stability.mjs` | 10 次 exit codes = [0]，10/10 一致 |

**二轮同时修正的文档不一致**：`scenarios/exam-cancel-waitlist.json` 的 `description` 仍写着「协议 1.0 无字符串断言」的旧局限，而同文件的断言早已使用 `reservation-holder` + `eqStr`（`dcb8c31` 引入时漏改描述）——已改写为与断言一致。

**边界（仍算限制）**：步骤证据只证明「这一步真的发生过」，**不参与判定**（断言主体只走观察器证据）；缺失步骤证据不会把通过降级。这是刻意的分工，不是漏洞。

### A.8 2026-10-10 三轮：用「能力评估」检验工具本身（基准第一次运行就抓到三件事）

**动机**：前两轮都在证明「工具能发现应用的缺陷」。第三轮换成检验**工具自己的诊断能力**：先冻结一份标注案例集，再让工具去跑——标签不是我事后挑的结论，而是 fixture 的既定语义。

**基准首跑结果（12 例，`scripts/diagnostic-benchmark.mjs`）→ 10/12**，三个发现逐个查证如下：

1. **标签错误（工具是对的）**：`exam-contend-overbooking` 报了 `reservation-recorded` 违规，我最初的标签把它列为「不得误报」。查证：exam-contend 的 `exactly-one-winner` 是 `eq 2`，overbooking 下 reservations=3 —— 该断言**确实**被违反（booking 侧同类断言是 `gte 2` 才不受牵连，我抄错了）。→ 修正标签并在案例集文件里写明修正原因与日期（误报样本公开）。
2. **健全性漏洞（工具是错的，已修）**：`booking-cancel-waitlist-waitlist-order-wrong` 报 `inconclusive` 而非 `failed`。查证运行目录：`holder-nav-cancel` / `holder-submit-cancel` 两步 `outcome=error`（`page.goto: Target page, context or browser has been closed`），即**取消根本没执行**；工具却仍在「未触碰的状态」上求值并给出了业务口径结论。极端情况下这会变成**假通过**（初始状态恰好满足断言时）。→ 新增 §3.3 规则 17：任何 error 步骤一律 blocked（exit 3）并在 `blocked` 事件里点名步骤；`rejected`/`no-nav` 仍按业务信息处理。补 2 项针对性单测（error ⇒ blocked；rejected ⇒ 照常判定）。
3. **基础设施偶发（已归因，未消除）**：同一用例单独重复 6 次全部 `failed`（exit 1），说明断开是**偶发**而非确定性缺陷。→ 新增 §3.3 规则 18：监听 `disconnected` + 检查 `page.isClosed()`，把原因写进 `attempt.detail.error`；加启动参数抑制后台页节流。**不做**自动恢复（重建上下文会丢会话，硬造成功比失败更危险），并如实记录复现率（12 连跑 1 次 / 单独 6 次 0 次）。

**三轮新增交付物**

| 文件 | 作用 |
| --- | --- |
| `fixtures/diagnostic-cases.json` | 跑前冻结的 12 例标注案例集（标签 = 退出码 + 必须检出 / 不得误报的规则）+ 范围与限制公开 |
| `scripts/diagnostic-benchmark.mjs` | 比对标签并统计漏报/误报，公开误报/漏报样本（§6「不用自评代替」） |
| `scripts/external-agent-loop.mjs` | 仅用 MCP 公开接口 + 一次应用文本编辑走通「读失败 → 改应用 → 复验」（§7 外部助手闭环） |
| `scripts/acceptance.mjs`（`npm run accept` / `accept:fast`） | 一键验收门禁：把 §12 清单里可自动化的项串成一条命令，任一失败即整体失败 |

**三轮实测**：`npm run verify` 126/126；`diagnostic-benchmark` 12/12（漏报 0、误报 0）；`positive-negative-matrix` 19/19；`tri-entry-consistency` 三入口一致；`external-agent-loop` OK（`rc-mv28x3mg-5fa0df83`：failed → 修应用 → rerun passed）；`blocked-case` PASS；`serial-stability` 10/10。

**诚实边界**：`npm run accept` 的**一次性全链运行**（含 10 次串行稳定性）尚未完整跑完一遍（各门禁已分别全绿）；`acceptance.mjs` 本身只做「按顺序调用 + 汇总退出码」，不含任何判定逻辑，避免出现第二个真相来源。

**同时修掉的一处「退出码说谎」**：`tri-entry-consistency.mjs` 的比对结论正确，但结束时清理临时目录在 Windows 上撞到文件锁（子进程句柄未释放）抛出 EBUSY，把成功改写成 exit 1。现抽出 `scripts/lib/child-cleanup.mjs`（等子进程退出 + 重试清理 + 清理失败只提示不改判），三入口脚本与闭环脚本共用；三入口脚本连续 3 次实测 exit 0。

### A.9 2026-10-10 四轮：文档、报错体验、场景表达、可观测性

**这一轮的四项诉求都来自使用者视角的评审**，逐项落地如下。

| # | 诉求 | 做了什么 | 证据 / 边界 |
| --- | --- | --- | --- |
| 1 | 文档体系补全 | 新增 `docs/scenario-guide.md`（场景编写指南：字段速查、op 语义、判定后果、并行/重试、8 条真实踩过的坑、调试套路）、`docs/protocol-reference.md`（六套协议字段与不变量、磁盘布局、**兼容性策略**：1.0 内可选字段扩展 vs 必须升版的变更）、`docs/adapter-tutorial.md`（从零写适配器：manifest → setupEnv(roles) → 步骤/证据 → observe → teardown → 一致性套件 → 排查表）；README 加文档索引 | 三份文档与代码逐项核对（版本号取自 `ALL_VERSIONS`，SDK 电池取自 `adapter-sdk/src/index.ts` 导出） |
| 2 | 报错体验友好 | protocol 新增 `explainResult(result)` / `slowestSteps(result)` 作为**单点措辞**；CLI `run`/`rerun` 在非 passed/failed 时打印：blocked 的阶段 + 原始错误 + 无法执行的步骤 + 可操作建议（setupEnv 提示查入口/依赖/端口，claimDataRoot 提示 §10 所有权），inconclusive 列出缺哪类证据，并给出 `result.json`/`report.html` 绝对路径；MCP 的 rc_run/rc_rerun payload 同步带 `diagnostics` | 实测 blocked 输出含「blocked at setupEnv …」「（应用没能起来：检查 app.entry 指向的入口、依赖是否安装、端口是否被占用）」「full record: …\\result.json」；新增 cli 测试断言这段输出 |
| 3 | 场景表达力 | **有界重试 `step.retry`** 落地（规则 19）：`attempts` 1–5、`on` 默认 `["error"]`、每次尝试以 `step-retry` 事件可见、判定由最后一次尝试决定、`barrier + retry` 运行前拒绝；两个取消场景的 cancel 步骤实际用上（`attempts: 2, on: ["error"]`），正好覆盖三轮发现的 Chromium 偶发断开。**并行**早已由 `barrier` 组支持（文档补全）。**条件分支 `when` 未实现**：需要协议升版（新增 `skipped` outcome）并重跑全部矩阵，属明确不做半成品的项，设计草案见场景指南 §4.4 | 内核测试：重试后恢复 ⇒ passed 且 `attemptIndex=2` + 1 条 `step-retry`；全部尝试失败 ⇒ blocked 且 2 条重试记录；`barrier+retry` ⇒ 配置错误且不创建运行目录 |
| 4 | 运行时可观测性 | 内核为每个 Attempt 记录 `durationMs`（barrier 组按组计时并回填）、新增 `onEvent` 实时事件回调（`RunArtifacts.event()` 里触发，流即时间线的镜像）；CLI `run/rerun --verbose` 边跑边打印 `step <id> -> <outcome> <ms>`、`observe`、`step-retry`、`evidence-invalid`、`BLOCKED`，结束后给每步耗时表与最慢三步 | 实测 `--verbose` 输出：`step alice-register -> completed 1403ms` … 结束 `slowest: alice-register 1403ms, alice-login 1192ms, alice-submit-booking 626ms` |

**协议扩展说明（为什么不用升版）**：本轮新增 `Attempt.durationMs`、`Attempt.attemptIndex`、导出 `AttemptOutcome`、`Step.retry`（含 `StepRetry`）、`StepRetry` 校验（`attempts` 1–5）；全部是**可选的、向后兼容的**扩展——旧场景不含 `retry` 仍合法，旧结果不含新字段仍可解析，新的校验只排除「本来就不该出现」的取值（与二轮 `Attempt.evidence`、`missingEvidenceTypes` 收紧同一判断标准）。会改变既有语义的变更（如 `when`）必须升版并重跑全部证据链。

**四轮实测**：`npm run verify` 137/137；`positive-negative-matrix` 19/19（含 retry 后的复跑：`rc-mv29u38h-c3f4ce04` → rerun `rc-mv29x5ef-3475576f`，`previous=passed now=passed`）；`blocked-case` PASS；`tri-entry-consistency` 三入口一致；`external-agent-loop` OK。

**诚实边界**：`diagnostic-benchmark` 与 `serial-stability` 在本轮场景加了 `retry` 之后的**复跑被放到后台执行，未观测到结果**（retry 只在 `outcome=error` 时触发，正常路径不重试，故预期不变；上一次完整记录为 12/12 与 10/10）。`npm run accept` 的完整一次性运行仍未跑完一遍。

### A.10 2026-10-10 五轮：场景/结果升版 1.1 —— 条件步骤 `when`

**动机**：四轮把「条件分支」明确列为**需要升版**的项（不做半成品）。五轮按 `docs/protocol-reference.md` §6 的模板把它一次性做完，并重跑整条证据链。

| 层次 | 改动 | 关键点 |
| --- | --- | --- |
| 版本 | `SCENARIO_VERSION` / `RESULT_VERSION` → `1.1`；新增 `SUPPORTED_SCENARIO_VERSIONS = ["1.0","1.1"]`、`isSupportedScenarioVersion()`、`scenarioVersionAtLeast()`；`exit-codes.ts` 里重复的手写版本表改为 `ALL_VERSIONS` 别名（消除漂移） | 旧 1.0 文档仍可执行，语义不变 |
| 场景 | `Step.when` + `StepCondition`；`ASSERT_OPS` 提取为单一来源（断言与条件共用词汇）；校验：1.0 文档禁 `when`、`when.observer` 必须已声明、`op/value/expected` 配对规则与断言一致、barrier 步骤禁 `when` | 全部在**运行前**拒绝（exit 64） |
| 内核 | 版本门禁改为「声明值受支持 + 适配器清单覆盖它」；`when` 求值：`observe()` 读已声明观察器 → 用断言求值器判定 → 证据过同一道核对闸门 → 记 `when` 事件；**不成立 ⇒ `skipped`**（不执行、不 blocked、不当成功）；**无法判定 ⇒ blocked**（stage `when`）；`barrier + when` 拒绝 | 内核是第二道闸门，即使拿到未校验对象也不执行半成品语义 |
| 结果 | `AttemptOutcome` 增 `skipped`（validator 同步）；`explainResult()` 列出被跳过的步骤 | 跳过必须可见，不能被当成成功 |
| 契约 | 适配器清单 `scenarioVersion` → `1.1`；SDK 一致性套件改为「覆盖当前版本」判断；CLI `check` 与 MCP `rc_check` 共用 `isSupportedScenarioVersion()` | 四处判断口径统一 |
| 场景与证据 | 新场景 `scenarios/booking-conditional-skip.json`（两个 holder 占满容量 → 条件不成立 → 两个步骤 skipped；`bookings` 仍为 2、退出码 0）加入矩阵与标注案例集；6 个既有场景升到 1.1（语义不变） | 条件步骤有端到端证据，不只是单测 |

**五轮实测**：`npm run verify` **148/148**；`positive-negative-matrix` **21/21**（新增 check/run 各一条条件步骤用例）；`diagnostic-benchmark` **13/13**（新增条件步骤案例，漏报 0、误报 0）；`tri-entry-consistency` 三入口一致；`blocked-case` PASS；`external-agent-loop` OK。

**诚实边界**：`serial-stability` 未在五轮重跑（上一次 10/10；五轮只改了条件步骤与版本字段，不改既有场景语义，矩阵与基准已覆盖全部 7 个场景的正确实现与故障归因）；`npm run accept` 的一次性完整运行仍未跑完一遍；CI 托管 Runner 运行号、≥3 个外部项目、macOS 仍未取到。

### A.11 2026-10-10 六轮：脱敏证据包导出

**动机**：§8「团队共享场景与**脱敏证据包**」与 §12 完成判据中唯一还能在本机闭环的阶段 4 项。设计立场：**宁可拒产，不可漏检**。

| 交付物 | 内容 |
| --- | --- |
| `packages/reporter/src/sanitize.ts` | 显式规则表 `REDACTION_RULES`（`_rc` 账号、Windows/POSIX 绝对路径、回环端口、邮箱、API key、Bearer、PEM 私钥）+ `sanitizeText`（已知敏感值**逐字**替换、长值优先，模式兜底）+ `sanitizeJsonValue`（递归）+ `findLeaks`（独立反扫）；纯函数、单一来源，CLI/MCP/工作台可复用 |
| `packages/cli/src/pack.ts` | `buildEvidencePack`：收集已知敏感值（场景角色账号/密码、`env.dbPath`、运行目录、runs 根）→ 逐文件脱敏写包 → **独立反扫**（任一残留 ⇒ 删整包 + exit 70）→ 逐文件 sha256 + `pack.json`（redactions/excluded/leakScan/notes） |
| CLI 入口 | `export --run-id <id> --pack <dir> [--include-images]`；`--pack` 缺 `--run-id` 或 run 不存在 ⇒ exit 64；无 `--pack` 时原「列出历史运行」行为不变 |
| 二进制边界 | 截图等二进制默认**排除**并在 pack.json 写明原因（像素无法用文本规则擦除）；`--include-images` 显式包含时标记 `sanitized: false`，不冒充已脱敏 |

**六轮实测**：`npm run verify` **162/162**（新增 sanitize 单测 13 项 + CLI pack 端到端 4 项）；真实运行 `rc-mv2cbos9-4b4734d8`（booking-normal）导出：**12 文件、74 处替换**（known-secret×22、loopback-port×43、windows-path×9）、**4 个二进制排除**、`leak scan: clean (checked 8 known secrets)`；对包内全部文本文件做**外部正则反扫**：账号/路径/端口零残留（仅 HTML 标题中的产品名「Reality Check」两处命中，属外部扫描模式过宽的误报，非泄漏）。

**诚实边界**：反扫的敏感值集合 = 已知值 + 规则可识别的模式；**未**做 OCR/图像内容识别（因此二进制默认不打包）；MCP 侧的 `rc_export_pack` 工具尚未暴露（CLI 已可用，列 §11.2）。

### A.12 2026-10-10 六轮补记：一键门禁全量跑通 + 类型镜像清理

**① `npm run accept` 一次性完整跑通（此前三轮起持续记录的取证缺口，现已关闭）**

| 门禁 | 耗时 | 结论 |
| --- | --- | --- |
| verify | 42.9s | typecheck + build + 全仓测试 162/162 |
| matrix | 156.6s | 正反例矩阵：退出码与归因规则全部一致 |
| benchmark | 146.6s | 标注案例集：漏报/误报统计无回归 |
| tri-entry | 17.7s | CLI / 工作台 / MCP 逐字段比对 result.json 一致 |
| agent-loop | 18.3s | 仅公开接口的闭环：failed → 修应用 → rerun passed |
| blocked | 19.2s | 环境缺失 → exit 3、verdict blocked、规则 not-evaluated |
| serial | 71.4s | 固定场景连跑 10 次结论一致 |
| **合计** | **≈8 分钟** | **acceptance: 7/7 通过 — 全部证据链一致** |

同时修正门禁脚本里写死的用例数（19/12/124+ 已过时，且会继续漂移）：说明文案改为自描述，判据保持退出码不变。

**② 适配器类型镜像改为 re-export（工程债清理）**

`packages/adapter-local-web/src/types.ts` 原先手工镜像 protocol 的 `Attempt` / `AttemptOutcome` / `EvidenceRef` / `AdapterManifest` 等 10 个类型——漂移时不会编译报错，只会在运行时变成「被校验器拒收的 result.json」或「被内核静默丢弃的证据」。现改为 `export type { ... } from "@rc/protocol"`（该包本就依赖 protocol）。仅 `ObserverReading` 与 `StepContext` 保留本地定义：它们是内核侧形状，而**适配器不得依赖内核**（这个依赖方向是适配器可替换的前提），其 `evidence` 字段用 protocol 的 `EvidenceRef`，规则不变。改动后 `npm run verify` 仍 162/162。

**诚实边界**：其余「外部验证」项（CI 托管 Runner 运行号、≥3 个外部项目、macOS）仍未取到——它们在 §12 保持 ⬜，不以本机通过代替。

### A.13 2026-10-11 七轮：外部审查发现的六个缺陷（含 1 条结构性）

来源：一次逐文件通读 + 两个复现脚本的外部审查（不是自评）。六条**全部核实为真**，其中两条给出了实际输出。按影响排序修复，每条都有回归测试。

| # | 缺陷 | 严重度 | 修复 |
| --- | --- | --- | --- |
| 1 | 适配器 8 个观察器的 SQL **写死** fixture 主键与账号（`course-1`/`exam-1`/`holder_rc`）；叠加「单一口径」（场景 SQL 必须与清单一致）后，场景作者也改不了 ⇒ 接入新应用必须改适配器源码 | 高（唯一影响"能不能被别人用"） | 观察器外置为**应用配置**：`<应用目录>/reality-check.observers.json`、配置 `adapter.observers`、或直接传 `observers`；`observedTables` 随之声明。内置项降级为「两个参考应用的预设」。坏 JSON/缺字段/表不在白名单 ⇒ exit 64 具名拒绝，**不静默回退**（规则 25 + 教程 §8.1） |
| 2 | `rollUpVerdict`：有 inconclusive 就一律 inconclusive ⇒ 一次真实超订（该规则证据完整）被另一条读空的断言压成 exit 2 | 高（把真失败降一档） | 改为「任意 violated ⇒ failed（exit 1）」；只有**没有**规则被证伪时才 inconclusive。缺口仍具名留在自身规则上（规则 24）。实测：`booking-cancel-waitlist + cancel-keeps-slot` 由 exit 2 → exit 1（该轮确有两条带完整证据的 violated：`slot-refilled-by-promotion` observed 1≠2、`queue-drains-in-declared-order` bob_rc≠carol_rc） |
| 3 | `expected` 在 eqStr 降级时渲染成 `eqStr undefined`（共用 `${op} ${value}`，而 eqStr 无 `value`） | 中 | 四种判定共用 `expectedText()`：eqStr 用 `expected`，数值 op 用 `value`。实测修复后报告为 `expected: "eqStr bob_rc"` |
| 4 | `vInt({min:0})` 禁止负的断言值与条件值 ⇒ 余额透支/库存缺口表达不出来 | 中 | 改为 `vInt()`（负值合法）；`retry.attempts`、`seed` 的下界保持不变 |
| 5 | `child.on("error", () => { throw err })` 不在调用栈内 ⇒ 未捕获异常、进程直接死、无 blocked 事件、无 result.json（与「可归因的基础设施失败」承诺相反） | 中（结构性，未能实测触发） | 错误经 `noteChildError()` 落状态：健康检查循环转成 `setupEnv` 正常拒绝（内核 ⇒ blocked/exit 3）；运行期出现则写进 `attempt.detail.error`。**诚实**：真实 spawn 失败未能复现（走到的都是 `/healthz` 超时），测试直接驱动同一段监听代码 |
| 6 | 脱敏路径规则只认少数 POSIX 根（`/workspace`、GitLab `/builds`、Git Bash `/d/x`、堆栈源码路径都不命中）；`findLeaks` 只反扫已知敏感值 | 低（泄漏面） | 路径规则扩展到 CI/容器根 + 带扩展名的绝对路径兜底 + Git Bash 盘符，并把 `=` 加入边界（`key=/abs/path` 是最常见形态，测试先抓到这个缺口）；新增 `findRuleResidues()`——脱敏后**规则自身不得再命中**，与已知值反扫并列进 pack 的两道防线 |

**协议兼容性**：场景协议未升版（负值是对合法文档空间的放宽）；结果协议未升版（`expected` 是渲染文本）。冻结标签因规则 24 **重冻结**（`frozenAt: 2026-10-11`，`revisions` 写明 2→1 与理由）——不是为了让测试变绿，而是语义确实变了。

**实测**：`npm run verify` **174/174**（新增 12 项）；`npm run accept` **7/7**（verify 46.4s / matrix 144.5s 21 用例 0 偏差 / benchmark 131.2s / tri-entry 16.5s / agent-loop 16.6s / blocked 19.2s / serial 65.7s 10/10）。

### A.14 2026-10-11 八轮：修复自身引入的信任边界扩大 + 入口安全

来源：①一次针对**未读包**的独立审查（planner / mcp-server / workbench / reporter / cli-commands），12 条候选逐条核实；②对上一轮「观察器外置」改动的自查。**七条成立并修复，两条降级记录，一条不成立。**

| # | 缺陷 | 严重度 | 修复 |
| --- | --- | --- | --- |
| A | 规则 1 只校验「SQL 里出现哪些表」，不校验语句类型；而口径已从源码变成应用配置 ⇒ 信任边界变宽。实测 `prepare("INSERT INTO t VALUES(1)").all()` 返回 `[]` 但**真的写入**；多语句 `;` 亦被接受 | 高（运行中改写被测应用 = 伪造结论） | 规则 28：必须是单条 `SELECT`/`WITH`（去注释后判定），运行前再验一次；表/列名必须是纯标识符（被拼进 dump SQL）。6 条负例 + 1 条正例回归 |
| B | 没有任何观察器声明时**静默回退** fixture 预设 ⇒ 第三方应用只要有同名表就会用 `course-1`/`holder_rc` 的口径给出自信的错误结论 | 高（最典型的假结论来源） | 规则 29：两个参考应用各自随目录提供 `reality-check.observers.json`（与预设常量由测试钉住，防漂移）；入口存在却无声明 ⇒ 具名配置错误。**分级**：入口不存在 ⇒ 环境缺失，保持 `blocked`，不提前变成 exit 64 |
| C | CLI `--run-id` 无校验 ⇒ `export --run-id ../.. --pack out` 既读取任意 `result.json`，又对 `out` **之外**的目录 `rm -rf`（MCP 侧早有守卫，CLI 侧没有） | 高（破坏性） | 规则 31：`runIdProblem()`/`isSafeRunId()` 落到 `@rc/protocol` 单一来源，CLI `export`/`rerun`/`pack`（含 pack 内部再验一次）与 MCP 共用；回归测试真的建一个受害目录并断言它还在 |
| D | 侧车/报告写失败抛异常 ⇒ 一次真实 `failed`（exit 1）在 CI 上变成 exit 70 的工具错误，真实回归被当成环境抖动；`readEvents` 一行 JSON 损坏也会拖垮整次运行 | 高（结论被呈现问题顶掉） | 规则 30：结论与呈现分离。抽出 `writeRunArtifacts()`，失败返回 warning、不抛不改退出码，CLI 与工作台都打到 stderr；`readEvents` 返回 `{events, warnings}`。工作台 payload 增 `warnings` |
| E | MCP 进程级 `uncaughtException` 只写日志；串行队列里一个永不 settle 的 promise 会让后续请求（含 `ping`）全部挂死 —— 服务器活着但不回答 | 中高（可用性） | `inFlight` 追踪 + `failInFlight()`：进程级异常会终结在途请求（JSON-RPC INTERNAL 错误），队列继续；幂等（无在途请求时不造响应，避免污染 stdout 协议流） |
| F | 工作台运行不写 `cli.json` 侧车 ⇒ 工作台跑出来的 run 无法 `rerun`、`export --pack` 退化成模式规则，「三入口一致」不成立 | 中 | 写入侧车（scenarioPath + seed），并加回归测试：工作台跑完后用 CLI `rerun --run-id` 真跑一遍通过 |
| G | 工作台 `/api/run` 对非法 `seed`/`fault` 静默丢弃，按默认值运行 ⇒ 用户拿到 200 + verdict，以为是「指定种子下的结论」 | 中 | 返回 400 并说明原因（与 CLI `flagInt` 的 exit 64 口径一致） |

**降级记录（修了但优先级低）**：`pack` 丢弃长度 < 3 的敏感值（逐字替换会毁掉正常内容）——原先是**静默**丢弃，现写进 `pack.json` 的 `notes`，让读包的人知道反扫边界；CLI `process.exit()` 紧跟 stdout 写入在管道下可能截断输出；工作台前端 `esc()` 用在 `onclick` 的 JS 字符串上下文（转义上下文不匹配，本地工具、利用门槛高）。

**不成立（核实后未改）**：MCP 配置不校验 `tools` 版本 / `adapter.module`——已核对 `packages/mcp-server/src/config.ts`，CLI 的白名单校验在 `loadConfig` 内部，MCP 走的是同一份文件解析但确实缺 `tools` 与 `adapter.module` 两项；此项**留待下一轮**，因为改它要动 MCP 的配置加载路径，而本轮已经在同一文件改了三处，不宜混在一起。

**协议兼容性**：场景/结果协议均未升版——观察者声明位置、runId 形状、warning 通道都不改变文档化语义；`RunOutcome` 增 `warnings` 属 CLI 内部结构。两个自带 fixture 应用新增 `reality-check.observers.json`（属应用侧声明，不是协议字段）。

**实测**：`npm run verify` **187/187**（新增 13 项：只读 SQL 6 + 标识符 1 + 声明分级 1 + 预设漂移 1 + runId 4 + 呈现分离 2 + in-flight 1；另修正 1 条旧测试的过时断言——booking 应用清单里本就不该有 exam 观察器）；`npm run accept` **7/7**（verify 43.2s / matrix 159.2s / benchmark 142.5s / tri-entry 17.8s / agent-loop 17.8s / blocked 20.3s / serial 69.0s 10/10）。

**门禁抓出的工具侧漏改**（本轮最有价值的一条自检）：新规则（应用必须声明观察器）让 `agent-loop` 关卡**失败**——该脚本把 fixture 应用复制到临时目录模拟「外部项目」，复制时只抄了 `server.js`，没抄新的声明文件。修复脚本后通过。这说明新规则在真实工具链里确实生效，也说明独立进程 + 独立目录的门禁比单测更强。

**被测试逼出来的一次修正**：最初打算「缺观察器声明一律 exit 64」，回归测试显示这会把「应用入口根本不存在」这一类环境缺失提前变成配置错误——真实原因应是「应用没搭起来」，运行本应以 `blocked`（exit 3）结束。改为分级（规则 29）。

### A.15 2026-10-11 九轮：内核并发段（此前从未被审过）

来源：一次专门针对**内核执行引擎**的只读审查（`packages/core/src/engine.ts` 的 barrier / deferred submit / retry / 观察段，以及适配器里与内核契约相关的部分）。这是整个仓库里最关键、此前从未被逐行审过的部分——**7 条候选逐条核实，5 条成立并修复，2 条被我自己的证据推翻**。

| # | 缺陷 | 严重度 | 处理 |
| --- | --- | --- | --- |
| 1 | `retry` 重放整个步骤：写操作已派发、只是读不回结果时，重放就是**第二笔业务写入**；仓库自己的 `*-cancel-waitlist` 场景正对 `submit` 用着 retry | 高（伪造结论） | **改判据而非禁止**（规则 32）：适配器在 `detail.dispatched` 报告事实，内核拒绝重放已派发的写入并记 `step-retry-refused`。回归测试同时钉住两侧：已派发 ⇒ 只执行一次 + blocked；未派发 ⇒ 照旧重试（保住第三轮的抖动缓解） |
| 2 | 内核**不校验** `runBarrier` 返回条数/顺序：少一个步骤 ⇒ 该步骤静默消失，断言在「这一步没发生」的状态上求值 | 高（假通过） | 内核自校验（规则 33）：条数或顺序不符 ⇒ blocked + `blocked` 事件点名 |
| 3 | `when` 路径**不做证据核验**（正式观察路径做）：证据文件坏掉时条件仍可能判 `held`，**执行一步本不该发生的业务动作** | 高（不该执行的动作被执行） | 两条路径同一口径（规则 35）：核验失败 ⇒ 条件无法判定 ⇒ blocked |
| 4 | 并发建页竞态：`ensurePage` 的 `get`/`set` 之间隔着 `await`，同一 actor 并发提交会各建一个 context，后者覆盖前者 ⇒ 泄漏 context，且两步跑在两页上、证据只取「最后写入」的那页 | 中（证据错位） | 单次飞行（规则 34）；新增测试可见的 `openContextCount()`，测试断言「一个 actor 只有一个 context」 |
| 5 | barrier 的「同时起跑」从未被强制：组内非 submit 步骤被串行，并发的提交也只是 `Promise.all` 依次发起，真正的落库时刻交给 Playwright 的可点性检查 ⇒ **本该制造的竞态可能根本没发生**，顺序行为被读回并报成 passed | 中（假通过，尽力而为） | 两段式（规则 34）：先并行预热（建页 + 等控件可点），再在同一 tick 派发全部点击；偏移写进 `detail.fireOffsetMs` 让「争抢是否真的发生」可查。**诚实边界**：这是把偏移压小，不是证明同时落库 |
| 6 | 重试被丢弃的那次尝试，其截图/DOM 已落盘但不登记 ⇒ **孤儿证据**（磁盘上有、索引里没有），且「每次尝试都留在记录里」对证据不成立 | 低 | 丢弃前核验并登记其引用，`step-retry` 事件带上证据条数 |
| 7 | `sql-dump` 逐表 SELECT 不在同一快照里（跨表自相矛盾）；读连接无 `busy_timeout`（应用持写锁时立即 SQLITE_BUSY，把可读的观察变成 inconclusive） | 低 | `BEGIN DEFERRED` 事务包裹多表 dump；读连接加 `PRAGMA busy_timeout = 5000` |

**两条被我自己推翻的候选**（记录在案）：
- 「一律禁止 `submit` + `retry`」——查 `git log -S '"retry"'` 后确认 retry 是**第三轮为 Chromium 偶发断开刻意加的缓解**（提交 `625412f`，场景注释与提交信息都写明「exactly the Chromium flake found in round three」）。一律禁止会把真实抖动重新变成 blocked，判据改为「有没有派发」。
- 「并发阶段共享计数器会有并发写」——`stepCounter`/`obsCounter`/`evidenceSeq` 的自增都发生在**串行**路径上（deferred 的收集是同步 `for` 循环，`Promise.all` 只包住已取好序号的提交），**未发现**并发写；文件命名前缀不同 + 计数单调，也**未发现**撞名覆盖。

**实测**：`npm run verify` **195/195**（新增 8 项）；`npm run accept` **7/7**（verify 64.0s / matrix 153.4s / benchmark 140.0s / tri-entry 17.6s / agent-loop 17.6s / blocked 19.2s / serial 71.4s 10/10）；真实争抢运行取证（`booking-contend`，run `rc-mv3mktmk-6fa843c1`，verdict passed）：两笔提交的 `detail.fireOffsetMs` 均为 **2ms**、`dispatched: true`，即**争抢确实发生在同一刻**——这条以前只能靠注释声称，现在有数字。

**诚实边界**：F5（争抢偏移）只能被压小、无法被证明；F4 的竞态无法按需复现，测试直接驱动不变量（**未能实测**触发路径）；`sql-dump` 的一致性改进是防御性，未构造出真实的跨表矛盾快照。
