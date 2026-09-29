/** @rc/mcp-server — MCP service over stdio (阶段3 §7). */
export { RealityCheckMcpServer, PROTOCOL_VERSION, TOOL_DEFS } from "./server.js";
export { loadMcpConfig, type McpConfig, type McpServerOptions } from "./config.js";
export {
  ToolError,
  checkScenario,
  checkCapabilities,
  loadScenarioFile,
} from "./capabilities.js";
export {
  toolCheck,
  toolRun,
  toolGetResult,
  toolRerun,
  MCP_META_FILE,
  type McpRunMeta,
  type ToolResult,
} from "./tools.js";
