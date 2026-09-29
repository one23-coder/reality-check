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
```

## 退出码契约

| 退出码 | 含义 |
|---|---|
| 0 | passed：全部断言在完整证据上成立 |
| 1 | failed：存在证据完整的业务违规 |
| 2 | inconclusive：证据不完整，违规降级并列出缺失证据类型 |
| 3 | blocked：环境或能力缺失，不构成业务结论 |
| 64 | 配置非法（运行前拒绝） |
| 70 | 工具自身异常 |

## 核心约束（不可后补）

- **数据隔离**：只初始化/重置工具创建并记录所有权的资源；已有内容但无所有权标记的数据根目录拒绝运行。
- **业务真相**：断言主体只走场景声明的观察器 SQL；观察器每次读取新建连接（WAL 可见性靠独立连接，不靠只读标志）。
- **证据**：适配器采集即落盘，内核登记时核对文件存在与哈希；完整性按要求的类型逐项核对。
- **模型边界**：无类别线索返回 `needsModel`；模型不可用/超时/预算耗尽/未知场景一律回退已保存场景；全程不执行自由生成的脚本。
