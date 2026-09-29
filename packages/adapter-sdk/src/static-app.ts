/** Static demo app — the "third app" of 方案 §8.
 *
 * A ~150-line, zero-dependency (node:http + node:sqlite) app that an external
 * contributor could serve with their own adapter: it demonstrates the WHOLE
 * app-side contract documented in docs/adapter-sdk.md —
 *
 *   - `GET /healthz` → 200 {"ok":true,"app":...,"version":...}   (health contract)
 *   - RC_PORT / RC_DB env vars pick the port and the SQLite file
 *   - SQLite in WAL mode, written by the app process
 *   - plain HTML + native-form POST (no fetch/preventDefault, §3.3 规则 5)
 *
 * It exists so the SDK's own tests can prove the docs suffice WITHOUT reading
 * kernel source: the app + SDK helpers (freePort/waitForHealth/freshSqliteRead)
 * form a complete, observable, testable unit.
 */
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { freePort } from "./helpers.js";

export interface StaticAppOptions {
  /** Port to listen on; defaults to a freshly probed free port (规则 10). */
  port?: number;
  /** SQLite file; defaults to a temp file that `close()` deletes. */
  dbPath?: string;
}

export interface StaticApp {
  port: number;
  baseUrl: string;
  dbPath: string;
  /** Stop the server, close the DB, remove the temp dir if we created one. */
  close(): Promise<void>;
}

const VERSION = "0.1.0";

export async function startStaticApp(opts: StaticAppOptions = {}): Promise<StaticApp> {
  const port = opts.port ?? (await freePort());
  let dbPath = opts.dbPath;
  let tempDir: string | null = null;
  if (dbPath === undefined) {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-static-app-"));
    dbPath = path.join(tempDir, "notes.db");
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  text TEXT NOT NULL
)`);
  const server = http.createServer((req, res) => {
    route(req, res, db).catch(() => {
      res.statusCode = 500;
      res.end("internal error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      if (tempDir !== null) await fsp.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, db: DatabaseSync): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    json(res, 200, { ok: true, app: "static-demo", version: VERSION });
    return;
  }
  if (req.method === "POST" && url.pathname === "/notes") {
    const form = new URLSearchParams(await readBody(req));
    const author = (form.get("author") ?? "").trim();
    const text = (form.get("text") ?? "").trim();
    if (author === "" || text === "") {
      json(res, 400, { error: "author and text are required" });
      return;
    }
    db.prepare("INSERT INTO notes (author, text) VALUES (?, ?)").run(author, text);
    json(res, 201, { ok: true });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/notes")) {
    const rows = db.prepare("SELECT id, author, text FROM notes ORDER BY id").all() as Array<{
      id: number;
      author: string;
      text: string;
    }>;
    const items = rows
      .map((r) => `<li>#${r.id} <b>${escapeHtml(r.author)}</b>: ${escapeHtml(r.text)}</li>`)
      .join("\n");
    html(
      res,
      200,
      `<!doctype html><html><body>
<h1>Static demo app</h1>
<ul id="notes">${items}</ul>
<form method="post" action="/notes">
  <input name="author" placeholder="author"><input name="text" placeholder="text">
  <button type="submit">Add</button>
</form>
</body></html>`,
    );
    return;
  }
  json(res, 404, { error: "not found" });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
