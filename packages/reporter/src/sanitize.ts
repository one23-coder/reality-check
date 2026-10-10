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
  // POSIX 常见绝对路径
  {
    name: "posix-path",
    pattern: /(?<=^|["'\s:(])\/(?:home|Users|tmp|var|opt|root|mnt|srv)\/[^"'\s,;)\]}]+/g,
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
export function findLeaks(text: string, secrets: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const secret of secrets) {
    if (secret.length < 3) continue;
    if (text.includes(secret)) leaks.push(secret.length > 80 ? `${secret.slice(0, 80)}…` : secret);
  }
  return leaks;
}
