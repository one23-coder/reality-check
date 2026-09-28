/** Exit codes and verdict semantics (方案 §10 结果语义). */

export type Verdict = "passed" | "failed" | "inconclusive" | "blocked";

export type ExitCode = 0 | 1 | 2 | 3 | 64 | 70;

export const VERDICT_EXIT: Record<Verdict, ExitCode> = {
  passed: 0,
  failed: 1,
  inconclusive: 2,
  blocked: 3,
};

export const EXIT_DESCRIPTION: Record<ExitCode, string> = {
  0: "passed: 全部断言在完整证据上成立",
  1: "failed: 存在证据完整的业务违规",
  2: "inconclusive: 证据不完整，违规降级并列出缺失证据类型",
  3: "blocked: 环境或适配器能力缺失，不构成业务结论",
  64: "配置非法：场景/清单/工具配置在运行前被拒",
  70: "工具自身异常：内核或适配器内部错误",
};

export const PROTOCOL_VERSIONS = {
  scenario: "1.0",
  result: "1.0",
  manifest: "1.0",
  adapterInterface: "1.0",
  runArtifacts: "1.0",
  tools: "0.1.0",
} as const;

export type ProtocolVersionKey = keyof typeof PROTOCOL_VERSIONS;
