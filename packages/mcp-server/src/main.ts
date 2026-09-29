/** `reality-check-mcp` — stdio entry point (阶段3 §7 MCP 服务).
 *
 * Line-delimited JSON-RPC 2.0 over stdin/stdout (StdioServerTransport
 * framing). HARD RULE: stdout carries protocol messages and NOTHING else;
 * every diagnostic goes to stderr. Process-level guards keep the loop alive
 * even when the adapter's app spawn surfaces errors as uncaughtException
 * (adapter-local-web throws inside its child 'error' handler), so a blocked
 * environment degrades to a verdict, never a dead server.
 */
import readline from "node:readline";
import { loadMcpConfig } from "./config.js";
import { RealityCheckMcpServer } from "./server.js";

function diag(message: string): void {
  process.stderr.write(`[reality-check-mcp] ${message}\n`);
}

process.on("uncaughtException", (err) => {
  diag(`uncaughtException (server stays up): ${err?.stack ?? String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  diag(`unhandledRejection (server stays up): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

const server = new RealityCheckMcpServer(loadMcpConfig(), (line) => {
  process.stdout.write(line + "\n");
}, diag);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => server.handleLine(line));
rl.on("close", () => {
  diag("stdin closed; exiting");
  process.exit(0);
});
