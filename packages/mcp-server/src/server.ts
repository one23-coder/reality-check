/** Minimal MCP over stdio (阶段3 §7) — hand-rolled JSON-RPC 2.0, newline-
 * delimited messages (the framing @modelcontextprotocol/sdk's
 * StdioServerTransport uses): each request arrives as one JSON line on stdin,
 * each response/notification leaves as ONE single-line JSON on stdout.
 * Nothing else is ever written to stdout; diagnostics go to stderr.
 *
 * Implemented surface (protocol 2024-11-05):
 *   initialize                  -> protocolVersion/capabilities/serverInfo
 *   notifications/initialized   -> ignored (no response to notifications)
 *   ping                        -> {}
 *   tools/list                  -> rc_check / rc_run / rc_get_result / rc_rerun
 *   tools/call                  -> dispatch by name; tool failures become
 *                                  {isError: true} results, never a crashed
 *                                  loop — every message is answered and the
 *                                  loop continues.
 */
import {
  EXIT_DESCRIPTION,
  VERDICT_EXIT,
  type ExitCode,
  type Verdict,
} from "@rc/protocol";
import type { McpConfig } from "./config.js";
import { ToolError } from "./capabilities.js";
import { toolCheck, toolGetResult, toolRerun, toolRun, type ToolResult } from "./tools.js";

export const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "reality-check", version: "0.1.0" } as const;

const JSONRPC_ERROR = {
  PARSE: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** JSON Schema for each tool's arguments (MCP inputSchema). */
export const TOOL_DEFS = [
  {
    name: "rc_check",
    description:
      "Validate a scenario against protocol 1.0 and gate it against the adapter manifest " +
      "(no app spawn). Config-class failures are reported, never guessed around.",
    inputSchema: {
      type: "object",
      properties: { scenarioPath: { type: "string", description: "Path to the scenario JSON" } },
      required: ["scenarioPath"],
      additionalProperties: false,
    },
  },
  {
    name: "rc_run",
    description:
      "Execute a scenario through the same kernel path as the CLI (executeScenario + " +
      "local-web adapter). Returns {runId, verdict, exitCode, ruleEvaluations}. A " +
      "blocked/inconclusive verdict is a RESULT (exit 3/2), not a tool error.",
    inputSchema: {
      type: "object",
      properties: {
        scenarioPath: { type: "string", description: "Path to the scenario JSON" },
        seed: { type: "integer", description: "Deterministic seed; defaults to the scenario's" },
        fault: { type: "string", description: "Fault switch override (RC_FAULT)" },
      },
      required: ["scenarioPath"],
      additionalProperties: false,
    },
  },
  {
    name: "rc_get_result",
    description:
      "Read a finished run: result.json + events.jsonl from the runs directory.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "rc_rerun",
    description:
      "Re-execute a previous run with the SAME scenario and seed (reads the run's " +
      "mcp.json sidecar, falling back to cli.json).",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOL_DEFS.map((t) => t.name));

export class RealityCheckMcpServer {
  /** Responses are serialized through this chain so concurrent requests keep
   * their stdout order stable. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: McpConfig,
    private readonly writeLine: (line: string) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Handle one raw stdin line. Parse failure -> error response with id null;
   * the loop never throws. */
  handleLine(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch (e) {
      this.log(`unparseable line: ${e instanceof Error ? e.message : String(e)}`);
      this.respondError(null, JSONRPC_ERROR.PARSE, "parse error: line is not valid JSON");
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
      this.respondError(null, JSONRPC_ERROR.INVALID_PARAMS, "invalid request: missing method");
      return;
    }
    const isNotification = msg.id === undefined;
    if (isNotification) {
      this.onNotification(msg.method);
      return;
    }
    if (typeof msg.id !== "string" && typeof msg.id !== "number") {
      this.respondError(null, JSONRPC_ERROR.INVALID_PARAMS, "invalid request: id must be a string or number");
      return;
    }
    const id: string | number = msg.id;
    const method: string = msg.method;
    // Serialize async handling to preserve response order on stdout.
    this.queue = this.queue.then(() => this.dispatch(id, method, msg.params)).catch(() => {});
  }

  private onNotification(method: string): void {
    switch (method) {
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // per spec: no response, nothing to do
      default:
        this.log(`ignored notification: ${method}`);
    }
  }

  private async dispatch(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case "initialize": {
          this.respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
          return;
        }
        case "ping": {
          this.respond(id, {});
          return;
        }
        case "tools/list": {
          this.respond(id, { tools: TOOL_DEFS });
          return;
        }
        case "tools/call": {
          const p = params as { name?: unknown; arguments?: unknown } | undefined;
          if (typeof p?.name !== "string" || !TOOL_NAMES.has(p.name)) {
            this.respondError(id, JSONRPC_ERROR.INVALID_PARAMS, `unknown tool: ${String(p?.name ?? "")}`);
            return;
          }
          if (typeof p.arguments !== "object" || p.arguments === null || Array.isArray(p.arguments)) {
            this.respondError(id, JSONRPC_ERROR.INVALID_PARAMS, "tools/call arguments must be an object");
            return;
          }
          const toolResult = await this.callTool(p.name, p.arguments as Record<string, unknown>);
          this.respond(id, {
            content: [{ type: "text", text: JSON.stringify(toolResult.payload) }],
            ...(toolResult.isError === true ? { isError: true } : {}),
          });
          return;
        }
        default:
          this.respondError(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (e) {
      // Last-resort guard: an unexpected throw must degrade to an error
      // response, never kill the loop.
      this.log(`internal error handling ${method}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      this.respondError(id, JSONRPC_ERROR.INTERNAL, e instanceof Error ? e.message : String(e));
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (name) {
        case "rc_check":
          return await toolCheck(this.config, args);
        case "rc_run":
          return await toolRun(this.config, args);
        case "rc_get_result":
          return await toolGetResult(this.config, args);
        case "rc_rerun":
          return await toolRerun(this.config, args);
        default:
          throw new ToolError(`unknown tool: ${name}`);
      }
    } catch (e) {
      if (e instanceof ToolError) {
        return { payload: { error: e.message }, isError: true };
      }
      throw e;
    }
  }

  private respond(id: string | number | null, result: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(id: string | number | null, code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}

export { EXIT_DESCRIPTION, VERDICT_EXIT };
export type { ExitCode, Verdict };
