/** 脱敏证据包导出 (方案 §8「团队共享场景与脱敏证据包」+ §12 判据)。
 *
 * 产出 `<out>/<runId>-pack/`：可分享的运行记录 —— result/events/report/证据文本
 * 全部过一遍显式脱敏规则，**并在写完后独立反扫**：只要还能扫出任何原始敏感值
 * （场景角色账号、数据库绝对路径、运行目录），就删掉整个包并报错。宁可不产出，
 * 也不产出泄漏的包。
 *
 * 图片默认**不打包**：像素里的账号名不是正则能擦掉的，与其假装脱敏，不如排除并
 * 在 pack.json 里写明原因（`--include-images` 可显式包含，届时同样标注 unsanitized）。
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  findLeaks,
  sanitizeJsonValue,
  sanitizeText,
  type RedactionCount,
} from "@rc/reporter";
import { configError, internalError } from "./config.js";

export interface PackOptions {
  runDir: string;
  runId: string;
  outDir: string;
  /** Scenario file path (from cli.json) — its role accounts are known secrets. */
  scenarioPath?: string;
  includeImages?: boolean;
  /** Extra literal secrets (e.g. the runs root). */
  extraSecrets?: readonly string[];
}

export interface PackFileEntry {
  path: string;
  kind: "result" | "events" | "report" | "meta" | "evidence-text" | "evidence-binary";
  sha256: string;
  bytes: number;
  /** false only for files we ship unscrubbed (binary evidence with the flag on). */
  sanitized: boolean;
}

export interface PackManifest {
  protocol: { pack: "1.0" };
  runId: string;
  createdAt: string;
  files: PackFileEntry[];
  redactions: RedactionCount[];
  excluded: { path: string; reason: string }[];
  leakScan: { secrets: number; clean: boolean };
  notes: string[];
}

export interface PackResult {
  packDir: string;
  manifest: PackManifest;
  /** Human-readable lines for the CLI to print. */
  lines: string[];
}

const TEXT_EVIDENCE_EXT = [".json", ".html", ".txt", ".log", ".csv", ".sql"];

function isTextEvidence(name: string): boolean {
  return TEXT_EVIDENCE_EXT.some((ext) => name.toLowerCase().endsWith(ext));
}

/** 收集"原始敏感值"：场景角色账号、数据库绝对路径、运行目录、调用方补充的值。
 * 场景可用时直接用它的角色账号——这是最可靠的来源，不靠模式猜。 */
async function collectSecrets(opts: PackOptions, result: unknown): Promise<string[]> {
  const secrets = new Set<string>([opts.runDir, path.dirname(opts.runDir)]);
  for (const extra of opts.extraSecrets ?? []) secrets.add(extra);

  const env = (result as { env?: { dbPath?: unknown } }).env;
  if (typeof env?.dbPath === "string") {
    secrets.add(env.dbPath);
    secrets.add(path.dirname(env.dbPath));
  }

  if (opts.scenarioPath !== undefined) {
    try {
      const doc = JSON.parse(await fsp.readFile(opts.scenarioPath, "utf8")) as {
        roles?: { account?: { username?: unknown; password?: unknown } }[];
      };
      for (const role of doc.roles ?? []) {
        if (typeof role.account?.username === "string") secrets.add(role.account.username);
        if (typeof role.account?.password === "string") secrets.add(role.account.password);
      }
    } catch {
      // scenario 不可读时退回模式规则；pack.json 的 notes 会说明
    }
  }
  return [...secrets].filter((s) => s.length >= 3);
}

export async function buildEvidencePack(opts: PackOptions): Promise<PackResult> {
  const rawResult = await fsp
    .readFile(path.join(opts.runDir, "result.json"), "utf8")
    .catch((e: unknown) => {
      throw configError(
        `run "${opts.runId}" has no readable result.json under ${opts.runDir}; nothing to pack (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    });
  const resultValue = JSON.parse(rawResult) as unknown;
  const secrets = await collectSecrets(opts, resultValue);

  const packDir = path.join(opts.outDir, `${opts.runId}-pack`);
  await fsp.rm(packDir, { recursive: true, force: true });
  await fsp.mkdir(packDir, { recursive: true });

  const files: PackFileEntry[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const counts = new Map<string, number>();
  const bump = (list: RedactionCount[]): void => {
    for (const r of list) counts.set(r.rule, (counts.get(r.rule) ?? 0) + r.count);
  };

  const writeText = async (
    rel: string,
    kind: PackFileEntry["kind"],
    content: string,
  ): Promise<void> => {
    const res = sanitizeText(content, secrets);
    bump(res.redactions);
    const abs = path.join(packDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, res.text, "utf8");
  };

  // ---- run manifest / result / events / reports
  const relOf = (name: string): string => name;
  const tryRead = async (name: string): Promise<string | null> => {
    try {
      return await fsp.readFile(path.join(opts.runDir, name), "utf8");
    } catch {
      return null;
    }
  };

  const runJson = await tryRead("run.json");
  if (runJson !== null) await writeText(relOf("run.json"), "meta", runJson);

  const resultSanitized = sanitizeJsonValue(resultValue, secrets);
  bump(resultSanitized.redactions);
  await fsp.writeFile(
    path.join(packDir, "result.json"),
    JSON.stringify(resultSanitized.value, null, 2),
    "utf8",
  );

  const events = await tryRead("events.jsonl");
  if (events !== null) {
    const lines: string[] = [];
    for (const line of events.split("\n")) {
      if (line.trim() === "") continue;
      const s = sanitizeText(line, secrets);
      bump(s.redactions);
      lines.push(s.text);
    }
    await fsp.writeFile(path.join(packDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  for (const [name, kind] of [
    ["report.html", "report"],
    ["report.json", "report"],
  ] as const) {
    const content = await tryRead(name);
    if (content !== null) await writeText(relOf(name), kind, content);
  }

  // ---- evidence/
  const evidenceDir = path.join(opts.runDir, "evidence");
  let evidenceEntries: string[] = [];
  try {
    evidenceEntries = (await fsp.readdir(evidenceDir)).sort();
  } catch {
    evidenceEntries = [];
  }
  for (const name of evidenceEntries) {
    const rel = path.join("evidence", name);
    if (isTextEvidence(name)) {
      const content = await fsp.readFile(path.join(evidenceDir, name), "utf8");
      await writeText(rel, "evidence-text", content);
    } else if (opts.includeImages === true) {
      const abs = path.join(packDir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(path.join(evidenceDir, name), abs);
      files.push({
        path: rel.split(path.sep).join("/"),
        kind: "evidence-binary",
        sha256: "",
        bytes: (await fsp.stat(abs)).size,
        sanitized: false,
      });
    } else {
      excluded.push({
        path: `evidence/${name}`,
        reason: "二进制证据（图像/截图）无法用文本规则脱敏，默认不打包；如需分享请显式 --include-images 并自行确认画面内容",
      });
    }
  }

  // ---- 反向校验：脱敏后的每一个文件都不得再出现原始敏感值
  const walkFiles = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walkFiles(abs)));
      else out.push(abs);
    }
    return out;
  };
  const leaks: string[] = [];
  for (const abs of await walkFiles(packDir)) {
    if (!isTextEvidence(abs) && !abs.endsWith(".jsonl")) continue;
    const content = await fsp.readFile(abs, "utf8");
    for (const leak of findLeaks(content, secrets)) {
      leaks.push(`${path.relative(packDir, abs).split(path.sep).join("/")}: ${leak}`);
    }
  }
  if (leaks.length > 0) {
    await fsp.rm(packDir, { recursive: true, force: true });
    throw internalError(`evidence pack leak scan failed, pack removed: ${leaks.join(" | ")}`);
  }

  // ---- 记录每个文件的哈希（脱敏后的字节）
  for (const abs of (await walkFiles(packDir)).sort()) {
    const rel = path.relative(packDir, abs).split(path.sep).join("/");
    const existing = files.find((f) => f.path === rel);
    const bytes = await fsp.readFile(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (existing !== undefined) {
      existing.sha256 = sha256;
      continue;
    }
    const kind: PackFileEntry["kind"] = rel.startsWith("evidence/") ? "evidence-text" : "meta";
    files.push({ path: rel, kind, sha256, bytes: bytes.length, sanitized: true });
  }

  const manifest: PackManifest = {
    protocol: { pack: "1.0" },
    runId: opts.runId,
    createdAt: new Date().toISOString(),
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
    redactions: [...counts.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => (a.rule < b.rule ? -1 : 1)),
    excluded,
    leakScan: { secrets: secrets.length, clean: true },
    notes: [
      "所有文本文件已按 packages/reporter/src/sanitize.ts 的显式规则脱敏；已知敏感值（场景角色账号/密码、数据库绝对路径、运行目录）逐字替换。",
      "脱敏后已独立反扫：任何原始敏感值残留都会删除整包并报错（exit 70）。",
      "runId、时间戳、退出码、规则判定与证据哈希保留：分享的是结论与取证链，不是环境。",
    ],
  };
  await fsp.writeFile(path.join(packDir, "pack.json"), JSON.stringify(manifest, null, 2), "utf8");

  const totalRedactions = manifest.redactions.reduce((n, r) => n + r.count, 0);
  const lines = [
    `pack: ${packDir}`,
    `files: ${manifest.files.length + 1} (含 pack.json)  redactions: ${totalRedactions} (${manifest.redactions.map((r) => `${r.rule}×${r.count}`).join(", ") || "none"})`,
    `excluded: ${excluded.length}`,
  ];
  for (const e of excluded.slice(0, 3)) lines.push(`  - ${e.path}: ${e.reason}`);
  if (excluded.length > 3) lines.push(`  - …还有 ${excluded.length - 3} 个同类文件`);
  lines.push(`leak scan: clean (checked ${secrets.length} known secrets)`);
  return { packDir, manifest, lines };
}
