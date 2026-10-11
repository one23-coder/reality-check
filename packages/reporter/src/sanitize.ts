/** 证据包脱敏 (方案 §8 审查项: 证据包脱敏检查 —— 导出包内不得残留账号、密钥、
 * 内部路径；§12 完成判据)。
 *
 * 设计原则：
 *   1. 规则是**显式表**，不是散在各处的正则，便于单测、审计与复用；
 *   2. 先按**已知敏感值**（场景角色账号、数据库绝对路径、运行目录）逐字替换，
 *      再按模式兜底——已知值最可靠，模式负责"没见过但一眼是敏感"的东西；
 *   3. 提供 `findLeaks()` 作为**独立的反向校验**：脱敏后必须扫不出任何原始敏感值，
 *      这一步失败就是导出失败（宁可不产出，也不产出泄漏的包）。
 *
 * 纯函数、无 IO：CLI / MCP / 工作台共用同一套规则与同一套校验。
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** Pattern rules, applied in order after the known-secret pass. */
export const REDACTION_RULES: readonly RedactionRule[] = [
  // 工具创建的测试账号约定后缀（README: 工具创建的测试账号）
  { name: "account-token", pattern: /\b[A-Za-z0-9._-]+_rc\b/g, replacement: "<account>" },
  // Windows 绝对路径（含盘符）
  { name: "windows-path", pattern: /[A-Za-z]:\\[^"'\s,;)\]}]+/g, replacement: "<path>" },
  // POSIX 常见绝对路径（CI 的默认工作目录也在内：GitLab 是 /builds，容器常挂
  // /workspace；缺了它们，一个跑在 CI 上的证据包会把构建机路径原样带出去）
  {
    name: "posix-path",
    pattern:
      // `=` 也在边界里：路径最常见的形态就是 `key=/abs/path`。
      /(?<=^|["'\s:(=])\/(?:home|Users|root|tmp|var|opt|srv|mnt|workspace|builds?|build|app|src|data|projects?|code|repo|Documents|Desktop|Library)\/[^"'\s,;)\]}]+/g,
    replacement: "<path>",
  },
  // 绝对路径兜底：以文件结尾的绝对路径（堆栈里的源码路径、构建产物路径）。
  // 只认带扩展名的路径，避免把 `/api/v1/bookings` 这类 URL 路径误伤成 <path>。
  {
    name: "posix-file-path",
    pattern:
      /(?<=^|["'\s:(=])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:json|jsonl|js|mjs|cjs|ts|tsx|sql|db|sqlite|png|jpg|jpeg|gif|html|log|txt|csv|yml|yaml|env|md)\b/g,
    replacement: "<path>",
  },
  // Git Bash / MSYS 的盘符式路径（/d/xxx/...）
  {
    name: "gitbash-path",
    pattern: /(?<=^|["'\s:(=])\/[a-zA-Z]\/(?:[^"'\s,;)\]}]+\/)+[^"'\s,;)\]}]+/g,
    replacement: "<path>",
  },
  // 本机回环地址 + 端口（端口随运行变化，不属于业务信息）
  { name: "loopback-port", pattern: /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, replacement: "http://127.0.0.1:<port>" },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "<email>" },
  {
    name: "api-key",
    pattern: /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{10,}\b/g,
    replacement: "<secret>",
  },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, replacement: "Bearer <secret>" },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "<private-key>",
  },
];

export interface RedactionCount {
  rule: string;
  count: number;
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fresh RegExp per call: /g regexes carry lastIndex state. */
function fresh(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

export interface SanitizeResult {
  text: string;
  redactions: RedactionCount[];
}

/** Redact `text`. `knownSecrets` are replaced literally (they win over patterns). */
export function sanitizeText(text: string, knownSecrets: readonly string[] = []): SanitizeResult {
  let out = text;
  const redactions: RedactionCount[] = [];

  const secrets = [...new Set(knownSecrets)].filter((s) => s.length >= 3);
  if (secrets.length > 0) {
    // 长的先替换，避免短串破坏长串（例如 runs 与 runs-exam 的路径前缀）
    const ordered = [...secrets].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(ordered.map(escapeLiteral).join("|"), "g");
    const hits = [...out.matchAll(fresh(pattern))].length;
    if (hits > 0) {
      redactions.push({ rule: "known-secret", count: hits });
      out = out.replace(pattern, "<redacted>");
    }
  }

  for (const rule of REDACTION_RULES) {
    const hits = [...out.matchAll(fresh(rule.pattern))].length;
    if (hits === 0) continue;
    redactions.push({ rule: rule.name, count: hits });
    out = out.replace(rule.pattern, rule.replacement);
  }

  return { text: out, redactions };
}

/** Recursively redact every string in a JSON-ish value. */
export function sanitizeJsonValue(
  value: unknown,
  knownSecrets: readonly string[] = [],
): { value: unknown; redactions: RedactionCount[] } {
  const counts = new Map<string, number>();
  const bump = (list: RedactionCount[]): void => {
    for (const r of list) counts.set(r.rule, (counts.get(r.rule) ?? 0) + r.count);
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const res = sanitizeText(node, knownSecrets);
      bump(res.redactions);
      return res.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  const result = walk(value);
  return { value: result, redactions: [...counts.entries()].map(([rule, count]) => ({ rule, count })) };
}

/** 反向校验：脱敏后的文本里**不得**再出现任何原始敏感值。
 * 返回命中的敏感值（截断到 80 字符，便于报错但不回显全文）；空数组 = 干净。 */
/** 规则自检: 脱敏后，任何模式规则都**不得**再命中。
 *
 * `findLeaks` 只认已知敏感值；这条补上另一半——规则本身（路径/密钥/账号模式）
 * 在脱敏后的文本里仍有命中，说明脱敏没做干净（例如一条没被规则表覆盖的路径
 * 形态）。宁可拒产，不可漏检。 */
export function findRuleResidues(text: string): string[] {
  const residues: string[] = [];
  for (const rule of REDACTION_RULES) {
    const match = fresh(rule.pattern).exec(text);
    if (match !== null && match[0] !== undefined)
      residues.push(`${rule.name}: ${match[0].slice(0, 60)}`);
  }
  return residues;
}

export function findLeaks(text: string, secrets: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const secret of secrets) {
    if (secret.length < 3) continue;
    if (text.includes(secret)) leaks.push(secret.length > 80 ? `${secret.slice(0, 80)}…` : secret);
  }
  return leaks;
}
