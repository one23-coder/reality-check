// Self-contained HTML report (方案 §6: 客观、可复跑、证据可点开).
// EVERY dynamic value goes through esc() — the report renders untrusted
// scenario/request/detail strings, so injection must be impossible.
import {
  SCENARIO_VERSION,
  TOOLS_VERSION,
  VERDICT_EXIT,
  type RunResult,
  type TimelineEvent,
  type Verdict,
} from "@rc/protocol";

/** HTML-escape any dynamic value before it enters markup or attributes. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const BADGE_TEXT: Record<Verdict, string> = {
  passed: "通过",
  failed: "失败",
  inconclusive: "无法判定",
  blocked: "受阻",
};

function showValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function ruleRows(result: RunResult): string {
  if (result.ruleEvaluations.length === 0) return "<tr><td colspan=\"6\">无</td></tr>";
  return result.ruleEvaluations
    .map((r) => {
      const missing =
        r.missingEvidenceTypes !== undefined
          ? ` (缺少证据: ${esc(r.missingEvidenceTypes.join(", "))})`
          : "";
      const evidence =
        r.evidenceRefs.map((e) => esc(e.file)).join("<br>") || "—";
      return (
        `<tr><td>${esc(r.ruleId)}</td>` +
        `<td>${esc(r.verdict)}${missing}</td>` +
        `<td>${esc(r.assertionId)}</td>` +
        `<td><code>${esc(showValue(r.observed))}</code></td>` +
        `<td>${esc(r.expected)}</td>` +
        `<td>${evidence}</td></tr>`
      );
    })
    .join("\n");
}

function attemptRows(result: RunResult): string {
  if (result.attempts.length === 0) return "<tr><td colspan=\"6\">无</td></tr>";
  return result.attempts
    .map((a) => {
      const detail = a.detail !== undefined ? esc(JSON.stringify(a.detail)) : "—";
      const status = a.httpStatus !== undefined ? String(a.httpStatus) : "—";
      return (
        `<tr><td>${esc(a.stepId)}</td><td>${esc(a.actor)}</td><td>${esc(a.op)}</td>` +
        `<td>${esc(a.outcome)}</td><td>${esc(status)}</td><td><code>${detail}</code></td></tr>`
      );
    })
    .join("\n");
}

function timelineRows(events: TimelineEvent[]): string {
  if (events.length === 0) return "<tr><td colspan=\"5\">无</td></tr>";
  return events
    .map((e) => {
      const actor = e.actor !== undefined ? esc(e.actor) : "—";
      const causation = e.causation !== undefined ? ` &#8592; seq ${e.causation}` : "";
      return (
        `<tr><td>${e.seq}</td><td><code>${esc(e.t)}</code></td><td>${esc(e.kind)}</td>` +
        `<td>${actor}</td><td><code>${esc(JSON.stringify(e.detail))}</code>${causation}</td></tr>`
      );
    })
    .join("\n");
}

function evidenceRows(result: RunResult): string {
  if (result.evidence.length === 0) return "<tr><td colspan=\"5\">无</td></tr>";
  return result.evidence
    .map((e) => {
      const actor = e.actor !== undefined ? esc(e.actor) : "—";
      return (
        `<tr><td>${esc(e.kind)}</td><td><code>${esc(e.file)}</code></td>` +
        `<td>${e.seq}</td><td>${actor}</td><td><code>${esc(e.sha256)}</code></td></tr>`
      );
    })
    .join("\n");
}

const CSS = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;color:#111;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #e4e4e7;padding-bottom:4px}
.meta{color:#555;font-size:13px;margin-bottom:16px}
.badge{display:inline-block;color:#fff;padding:3px 12px;border-radius:999px;font-weight:600;font-size:14px;vertical-align:middle}
.badge-passed{background:#15803d}
.badge-failed{background:#b91c1c}
.badge-inconclusive{background:#b45309}
.badge-blocked{background:#4b5563}
table{border-collapse:collapse;width:100%;margin:8px 0 12px;font-size:13px}
th,td{border:1px solid #d4d4d4;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f4f4f5}
code,pre{background:#f4f4f5;border-radius:4px;font-size:12.5px}
code{padding:1px 4px}
pre{padding:10px;overflow-x:auto}
`;

export function renderHtmlReport(result: RunResult, events: TimelineEvent[]): string {
  const exit = VERDICT_EXIT[result.verdict];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Reality Check 执行报告 ${esc(result.runId)}</title>
<style>${CSS}</style>
</head>
<body>
<h1>Reality Check 执行报告</h1>
<p class="meta">
运行 <strong>${esc(result.runId)}</strong> · 场景 <strong>${esc(result.scenarioId)}</strong> ·
种子 ${result.seed} ·
<span class="badge badge-${esc(result.verdict)}">${esc(result.verdict)} (exit ${exit}) · ${esc(BADGE_TEXT[result.verdict])}</span>
</p>

<h2>业务规则</h2>
<table>
<tr><th>规则</th><th>判定</th><th>断言</th><th>观测值</th><th>期望</th><th>证据文件</th></tr>
${ruleRows(result)}
</table>

<h2>实验条件</h2>
<table>
<tr><th>项目</th><th>值</th></tr>
<tr><td>应用版本</td><td>${esc(result.env.appVersion)}</td></tr>
<tr><td>适配器版本</td><td>${esc(result.env.adapterVersion)}</td></tr>
<tr><td>Base URL</td><td><code>${esc(result.env.baseUrl)}</code></td></tr>
<tr><td>数据库</td><td>${result.env.dbPath !== undefined ? `<code>${esc(result.env.dbPath)}</code>` : "—"}</td></tr>
<tr><td>种子 (seed)</td><td>${result.env.seed}</td></tr>
<tr><td>平台</td><td>${esc(result.env.platform)}</td></tr>
<tr><td>协议版本</td><td>场景 ${esc(SCENARIO_VERSION)} / 结果 ${esc(result.protocol.result)} / 工具 ${esc(TOOLS_VERSION)}</td></tr>
</table>

<h2>操作与请求时间线</h2>
<p class="meta">因果边以 &#8592; seq N 标注。</p>
<table>
<tr><th>步骤</th><th>角色</th><th>操作</th><th>结果</th><th>HTTP</th><th>明细</th></tr>
${attemptRows(result)}
</table>
<table>
<tr><th>seq</th><th>时间</th><th>类型</th><th>角色</th><th>明细 / 因果</th></tr>
${timelineRows(events)}
</table>

<h2>证据</h2>
<table>
<tr><th>类型</th><th>文件</th><th>seq</th><th>角色</th><th>SHA-256</th></tr>
${evidenceRows(result)}
</table>

<h2>复跑入口</h2>
<pre><code>npx reality-check rerun --run-id ${esc(result.runId)}</code></pre>
</body>
</html>
`;
}
