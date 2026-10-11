/** `.reality-check.json` 的**跨入口共用判定**（方案 §7：同一配置经 CLI / MCP /
 * 工作台运行时语义一致）。
 *
 * 为什么放在协议包：这个判断必须只有一份实现。CLI 曾校验 `tools` 版本与
 * `adapter.module` 白名单（非法即 exit 64），MCP 侧却整段忽略——同一份配置在
 * 两个入口得到两种判决，"三入口一致"就只是文案。与 runId 形状（`run-id.ts`）
 * 同样的处理：判定在协议层，入口只负责怎么报错。
 */
import { TOOLS_VERSION } from "./versions.js";

/** The `@reality-check/adapter-local-web` workspace package has historically
 * also been referenced as `@rc/adapter-local-web` in docs; both are accepted. */
export const ADAPTER_MODULES = ["@reality-check/adapter-local-web", "@rc/adapter-local-web"] as const;

/** 从一份 `.reality-check.json` 的对象值里挑出**两个入口都必须拒绝**的配置问题。
 *
 * 只检查"同一份文件在哪个入口都不该被接受"的字段（版本与适配器白名单），
 * 不检查路径类字段——MCP 允许纯 opts 运行（没有配置文件也要能工作）。
 * `requireTools: true` 用于"文件确实存在"的场合：CLI 的 schema 把 `tools` 列为
 * 必填，MCP 若默默容忍缺失，同一份文件就会在两个入口得到两种判决。
 *
 * 返回人类可读的问题列表（空数组 = 通过）。 */
export function checkToolsConfig(
  raw: unknown,
  source: string,
  opts: { requireTools?: boolean } = {},
): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return [`${source}: expected a JSON object`];
  const obj = raw as { tools?: unknown; adapter?: { module?: unknown } };
  const problems: string[] = [];
  if (obj.tools === undefined && opts.requireTools === true)
    problems.push(`${source}: "tools" is required (expected "${TOOLS_VERSION}")`);
  if (obj.tools !== undefined && obj.tools !== TOOLS_VERSION)
    problems.push(
      `${source}: tools version must be "${TOOLS_VERSION}", got ${JSON.stringify(obj.tools)}`,
    );
  const module = obj.adapter?.module;
  if (
    module !== undefined &&
    (typeof module !== "string" || !(ADAPTER_MODULES as readonly string[]).includes(module))
  )
    problems.push(
      `${source}: adapter.module must be one of [${ADAPTER_MODULES.join("|")}], got ${JSON.stringify(module)}`,
    );
  return problems;
}
