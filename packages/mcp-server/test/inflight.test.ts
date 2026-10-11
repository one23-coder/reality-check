/** MCP in-flight failure contract (no browser).
 *
 * Requests are serialized through a single promise chain, so ONE request whose
 * promise never settles blocks every later request — including `ping`. The
 * process-level handlers (main.ts) therefore call `failInFlight` to answer the
 * pending request instead of leaving the client hanging forever.
 *
 * The wedge itself cannot be produced on demand (same situation as the spawn
 * failure case), so this test drives the contract directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RealityCheckMcpServer } from "../src/server.js";

interface RpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  error?: { code: number; message: string };
}

test("a process-level error fails the in-flight request instead of wedging the queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rc-mcp-inflight-"));
  try {
    const written: string[] = [];
    const server = new RealityCheckMcpServer(
      { runsDir: path.join(dir, "runs"), scenariosDir: dir },
      (line) => written.push(line),
    );
    (server as unknown as { inFlight: unknown }).inFlight = { id: 42 };
    server.failInFlight("uncaughtException: simulated");

    const msgs = written.map((l) => JSON.parse(l) as RpcResponse);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.id, 42);
    assert.equal(msgs[0]!.error?.code, -32603);
    assert.match(msgs[0]!.error?.message ?? "", /simulated/);

    // 幂等：没有 in-flight 请求时不应凭空造响应（否则会污染 stdout 协议流）。
    server.failInFlight("second");
    assert.equal(written.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});