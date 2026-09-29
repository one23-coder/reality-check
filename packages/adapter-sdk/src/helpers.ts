/** Batteries for adapter authors (方案 §8: 适配器 SDK).
 *
 * Every hard-won invariant from the工程方案 §3.3 rules is available here as a
 * function, so an external adapter gets them right by construction instead of
 * by re-reading kernel source:
 *
 * - `freshSqliteRead` implements 规则 1 (独立状态观察器每次读取都新建连接再关闭
 *   + SQL 层只读白名单) — a NEW connection per read, whitelist check, close in
 *   `finally`. A long-lived connection parks on a stale WAL snapshot and
 *   `readOnly: true` does NOT see WAL content; independence comes from fresh
 *   connections plus a table whitelist, never from SQLite read-only flags.
 * - `writeEvidenceFile` implements 铁律 3 (证据采集即落盘 + 哈希登记) — bytes
 *   hit the run directory immediately and the returned EvidenceRef carries the
 *   sha256 of the exact bytes written. No placeholder evidence, ever.
 * - `freePort` implements 规则 10 (端到端测试并行时必须分配独立端口).
 * - `spawnApp` / `waitForHealth` give every adapter the same SIGTERM→SIGKILL
 *   app lifecycle and health-poll semantics as the reference implementation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { EvidenceKind, EvidenceRef } from "@rc/protocol";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Probe an unused loopback port (规则 10: parallel runs must not share ports). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("failed to probe a free port")));
      }
    });
  });
}

/** Poll `${baseUrl}/healthz` until it answers 2xx (the app-under-test contract
 * used by every Reality Check app). Throws with the last error after timeoutMs. */
export async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/healthz`;
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = msg(e);
    }
    await sleep(150);
  }
  throw new Error(`no healthy /healthz at ${url} within ${timeoutMs}ms (last: ${last})`);
}

/** A spawned app-under-test process with honest teardown: SIGTERM, wait up to
 * 3s for exit, then SIGKILL. `stop()` is safe to call more than once. */
export interface SpawnedApp {
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Spawn a node app entry (e.g. the fixture `server.js`) with the given env
 * (RC_PORT / RC_DB / RC_SEED / RC_FAULT, see docs/adapter-sdk.md). */
export function spawnApp(entry: string, env: NodeJS.ProcessEnv = process.env): SpawnedApp {
  const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
  return {
    child,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      await Promise.race([exited, sleep(3000)]);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      await Promise.race([exited, sleep(1000)]);
    },
  };
}

/** sha256 of a file's exact bytes — the hash every EvidenceRef must carry. */
export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}

export interface WriteEvidenceOptions {
  /** Evidence kind for the ref; defaults to "page-text". */
  kind?: EvidenceKind;
  /** Actor-role perspective this evidence belongs to (角色视角). */
  actor?: string;
  /** Sequence number; defaults to 1 (monotonicity is the caller's duty). */
  seq?: number;
}

/** Write evidence bytes into `<runDir>/evidence/<name>` immediately and return
 * an EvidenceRef whose sha256 hashes the exact bytes written (铁律 3: 采集即
 * 落盘、内核核对 — never return a ref for content that is not on disk). */
export async function writeEvidenceFile(
  runDir: string,
  name: string,
  content: string | Uint8Array,
  opts: WriteEvidenceOptions = {},
): Promise<EvidenceRef> {
  const file = path.join(runDir, "evidence", name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const bytes =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  await fsp.writeFile(file, bytes);
  const ref: EvidenceRef = {
    kind: opts.kind ?? "page-text",
    file: path.relative(runDir, file).split(path.sep).join("/"),
    seq: opts.seq ?? 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (opts.actor !== undefined) ref.actor = opts.actor;
  return ref;
}

/** Table names touched by a SQL statement (from/join/into/update targets). */
export function extractSqlTables(sql: string): string[] {
  const SQL_TABLE_RE = /\b(?:from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  return [...new Set([...sql.matchAll(SQL_TABLE_RE)].map((m) => m[1] as string))];
}

/** Independent business-state read (规则 1, by construction):
 *
 * 1. whitelist check FIRST — the SQL may only touch tables in `allowedTables`
 *    (the manifest's observedTables); anything else is rejected before any
 *    connection is opened;
 * 2. a NEW node:sqlite connection is opened for THIS read only;
 * 3. the connection is closed in `finally`, whatever happens.
 *
 * This is the only reliable way to observe an app that writes to the same
 * SQLite file from another process in WAL mode: fresh connections see
 * committed WAL content, long-lived connections park on stale snapshots and
 * `readOnly: true` does not see WAL at all.
 */
export async function freshSqliteRead(
  dbPath: string,
  sql: string,
  allowedTables: readonly string[],
): Promise<Record<string, unknown>[]> {
  const touched = extractSqlTables(sql);
  if (touched.length === 0) {
    throw new Error(`observer SQL touches no recognizable table (from/join/into/update): ${sql}`);
  }
  const rogue = touched.filter((t) => !allowedTables.includes(t));
  if (rogue.length > 0) {
    throw new Error(
      `observer SQL touches table(s) outside the whitelist [${allowedTables.join(", ")}]: ${rogue.join(", ")}`,
    );
  }
  const db = new DatabaseSync(dbPath); // NEW connection per read — never reuse
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
