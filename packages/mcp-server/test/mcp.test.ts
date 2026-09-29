/** MCP over stdio — black-box protocol tests (阶段3 §7).
 *
 * Spawns `node dist/src/main.js` and speaks newline-delimited JSON-RPC 2.0
 * over its stdin/stdout, exactly like an MCP client. Covers: initialize,
 * tools/list (4 tools), rc_check against the repo's booking-normal scenario,
 * rc_run with a config whose app entry does not exist (verdict "blocked" —
 * a RESULT, not a crash; the loop must answer the NEXT request),
 * rc_get_result, rc_rerun, malformed-JSON-line survival, and unknown-method
 * errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_JS = path.join(PKG_ROOT, "dist", "src", "main.js");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const BOOKING_NORMAL = path.join(REPO_ROOT, "scenarios", "booking-normal.json");

interface RpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type Matcher = (msg: RpcResponse) => boolean;

interface Waiter {
  match: Matcher;
  resolve: (msg: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal stdio MCP client for tests: one JSON line per message. */
class McpClient {
  private child: ChildProcess;
  private buffer = "";
  private received: RpcResponse[] = [];
  private waiters: Waiter[] = [];
  private nextId = 1;
  stderrText = "";

  constructor(cwd: string) {
    this.child = spawn(process.execPath, [MAIN_JS], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrText += chunk;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() !== "") this.onMessage(JSON.parse(line) as RpcResponse);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onMessage(msg: RpcResponse): void {
    const wi = this.waiters.findIndex((w) => w.match(msg));
    if (wi >= 0) {
      const w = this.waiters.splice(wi, 1)[0] as Waiter;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.received.push(msg);
  }

  send(message: unknown): void {
    this.child.stdin?.write(JSON.stringify(message) + "\n");
  }

  sendRaw(line: string): void {
    this.child.stdin?.write(line + "\n");
  }

  waitFor(match: Matcher, timeoutMs: number, label: string): Promise<RpcResponse> {
    const buffered = this.received.findIndex(match);
    if (buffered >= 0) {
      return Promise.resolve(this.received.splice(buffered, 1)[0] as RpcResponse);
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex((w) => w.timer === timer);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error(`timeout waiting for ${label}; stderr: ${this.stderrText}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer });
    });
  }

  /** JSON-RPC request; resolves with the matching response. */
  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<RpcResponse> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return this.waitFor((m) => m.id === id && (m.result !== undefined || m.error !== undefined), timeoutMs, method);
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  /** The single text content block of a tools/call result, parsed. */
  static textPayload(res: RpcResponse): Record<string, unknown> {
    const result = res.result as { content?: { type: string; text: string }[] } | undefined;
    const block = result?.content?.[0];
    assert.ok(block, `tools/call result has no content: ${JSON.stringify(res)}`);
    assert.equal(block.type, "text");
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      setTimeout(() => {
        this.child.kill();
        resolve();
      }, 5000).unref();
    });
  }
}

test("initialize, tools/list, rc_check, and loop survival on malformed input", async () => {
  const client = new McpClient(REPO_ROOT);
  try {
    // initialize
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rc-test", version: "0.0.0" },
    });
    const initResult = init.result as {
      protocolVersion: string;
      capabilities: { tools: Record<string, unknown> };
      serverInfo: { name: string; version: string };
    };
    assert.equal(initResult.protocolVersion, "2024-11-05");
    assert.ok(initResult.capabilities.tools, "capabilities.tools missing");
    assert.equal(initResult.serverInfo.name, "reality-check");
    client.notify("notifications/initialized");

    // tools/list -> exactly the four tools
    const list = await client.request("tools/list");
    const tools = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(tools.sort(), ["rc_check", "rc_get_result", "rc_rerun", "rc_run"]);

    // tools/call rc_check on the repo's normal booking scenario
    const check = await client.request("tools/call", {
      name: "rc_check",
      arguments: { scenarioPath: BOOKING_NORMAL },
    });
    assert.notEqual(
      (check.result as { isError?: boolean }).isError,
      true,
      `rc_check reported error: ${JSON.stringify(check)}`,
    );
    const checkPayload = McpClient.textPayload(check);
    assert.equal(checkPayload.valid, true);
    assert.equal(checkPayload.scenarioId, "booking-normal");

    // invalid scenario path -> isError:true with the message, loop continues
    const badCheck = await client.request("tools/call", {
      name: "rc_check",
      arguments: { scenarioPath: path.join(REPO_ROOT, "scenarios", "no-such-scenario.json") },
    });
    assert.equal((badCheck.result as { isError?: boolean }).isError, true);
    const badPayload = McpClient.textPayload(badCheck);
    assert.match(String(badPayload.error), /scenario file not found/);

    // unknown method -> JSON-RPC error -32601
    const unknown = await client.request("resources/list");
    assert.equal(unknown.error?.code, -32601);

    // malformed JSON line -> parse error response, server survives
    client.sendRaw("this is definitely not json {{{");
    const parseErr = await client.waitFor(
      (m) => m.error?.code === -32700,
      10_000,
      "parse error response",
    );
    assert.equal(parseErr.id, null);

    // loop survival: the server still answers normal requests afterwards
    const after = await client.request("tools/list");
    assert.equal((after.result as { tools: unknown[] }).tools.length, 4);
  } finally {
    await client.close();
  }
});

test("rc_run with nonexistent app entry -> verdict blocked; get_result; rerun; loop survives", async () => {
  // Temp project dir: config points at a missing app entry, so setupEnv must
  // fail and the kernel must return verdict "blocked" (exit 3) — an
  // environment problem, never a business conclusion, never a crash (方案 §7).
  const dir = await mkdtemp(path.join(tmpdir(), "rc-mcp-"));
  try {
    await writeFile(
      path.join(dir, ".reality-check.json"),
      JSON.stringify({
        tools: "0.1.0",
        app: { kind: "local-web", entry: "./does-not-exist/server.js" },
        adapter: { module: "@rc/adapter-local-web" },
        runsDir: "runs",
        scenariosDir: "scenarios",
      }),
      "utf8",
    );
    const client = new McpClient(dir);
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      client.notify("notifications/initialized");

      const run = await client.request(
        "tools/call",
        { name: "rc_run", arguments: { scenarioPath: BOOKING_NORMAL } },
        120_000,
      );
      assert.notEqual(
        (run.result as { isError?: boolean }).isError,
        true,
        `blocked must be a RESULT, not a tool error: ${JSON.stringify(run)}`,
      );
      const runPayload = McpClient.textPayload(run);
      assert.equal(runPayload.verdict, "blocked");
      assert.equal(runPayload.exitCode, 3);
      const runId = String(runPayload.runId);
      assert.ok(runId.length > 0);
      const rules = runPayload.ruleEvaluations as {
        total: number;
        notEvaluated: number;
        violated: number;
      };
      assert.equal(rules.total, 2);
      assert.equal(rules.notEvaluated, 2);
      assert.equal(rules.violated, 0);

      // rc_get_result reads result.json + events.jsonl from the run dir
      const get = await client.request("tools/call", {
        name: "rc_get_result",
        arguments: { runId },
      });
      assert.notEqual((get.result as { isError?: boolean }).isError, true);
      const getPayload = McpClient.textPayload(get);
      assert.equal(getPayload.verdict, "blocked");
      const storedResult = getPayload.result as {
        protocol: { result: string };
        runId: string;
        verdict: string;
      };
      assert.equal(storedResult.protocol.result, "1.0");
      assert.equal(storedResult.runId, runId);
      assert.equal(storedResult.verdict, "blocked");
      assert.ok(Array.isArray(getPayload.events) && getPayload.events.length > 0);

      // rc_rerun: same scenario, same seed, new run
      const rerun = await client.request(
        "tools/call",
        { name: "rc_rerun", arguments: { runId } },
        120_000,
      );
      assert.notEqual((rerun.result as { isError?: boolean }).isError, true);
      const rerunPayload = McpClient.textPayload(rerun);
      assert.equal(rerunPayload.verdict, "blocked");
      assert.equal(rerunPayload.previousRunId, runId);
      assert.notEqual(String(rerunPayload.runId), runId);

      // loop survival after two full blocked runs
      const after = await client.request("tools/list");
      assert.equal((after.result as { tools: unknown[] }).tools.length, 4);
    } finally {
      await client.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
