/** `reality-check-mcp` — stdio entry point (阶段3 §7 MCP 服务).
 *
 * Line-delimited JSON-RPC 2.0 over stdin/stdout (StdioServerTransport
 * framing). HARD RULE: stdout carries protocol messages and NOTHING else;
 * every diagnostic goes to stderr. Process-level guards keep the loop alive
 * when something throws outside any await chain — but they must also **unblock
 * the in-flight request**: an error that never settles its promise would leave
 * the serialized queue wedged forever, and a server that stops answering is
 * worse than one that reports a failed request.
 */
import readline from "node:readline";
import { loadMcpConfig } from "./config.js";
import { RealityCheckMcpServer } from "./server.js";

function diag(message: string): void {
  process.stderr.write(`[reality-check-mcp] ${message}\n`);
}

process.on("uncaughtException", (err) => {
  diag(`uncaughtException (server stays up): ${err?.stack ?? String(err)}`);
  server.failInFlight(`uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  diag(`unhandledRejection (server stays up): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  server.failInFlight(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// 配置在启动时读取：非法就在**任何请求之前**干净退出（与 CLI 同为 exit 64），
// 不留一个"活着但永远答不对"的服务。此前这里抛出的异常会走到全局处理器，
// 而处理器里引用的 `server` 尚未初始化。
let server: RealityCheckMcpServer;
try {
  server = new RealityCheckMcpServer(loadMcpConfig(), (line) => {
    process.stdout.write(line + "\n");
  }, diag);
} catch (e) {
  diag(`config error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(64);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => server.handleLine(line));
rl.on("close", () => {
  diag("stdin closed; exiting");
  process.exit(0);
});
