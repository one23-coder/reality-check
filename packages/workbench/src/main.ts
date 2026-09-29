#!/usr/bin/env node
/** rc-workbench — start the local rehearsal workbench (方案 §6 阶段 2).
 *
 * Usage: node dist/src/main.js [--port 7788] [--runs-dir runs]
 *        [--scenarios-dir scenarios] [--app-path fixtures/booking-app/server.js]
 * Defaults come from .reality-check.json in the cwd when present.
 */
import fs from "node:fs";
import path from "node:path";
import { assertStaticUi, DEFAULT_PORT, startWorkbench } from "./server.js";

interface FileConfig {
  app?: { entry?: string };
  runsDir?: string;
  scenariosDir?: string;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadFileConfig(): FileConfig {
  try {
    return JSON.parse(fs.readFileSync(".reality-check.json", "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

const argv = process.argv.slice(2);
const file = loadFileConfig();
const portFlag = flag(argv, "port");
const port = portFlag !== undefined ? Number(portFlag) : DEFAULT_PORT;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be an integer 0-65535, got "${portFlag}"`);
  process.exit(64);
}
const runsDir = path.resolve(flag(argv, "runs-dir") ?? file.runsDir ?? "runs");
const scenariosDir = path.resolve(flag(argv, "scenarios-dir") ?? file.scenariosDir ?? "scenarios");
const appPath = path.resolve(flag(argv, "app-path") ?? file.app?.entry ?? "");
if (appPath === "" || !fs.existsSync(appPath)) {
  console.error(`--app-path missing or not found: "${appPath}" (fixture app entry)`);
  process.exit(64);
}

assertStaticUi();
const wb = await startWorkbench({ port, runsDir, scenariosDir, appPath });
console.log(`本地演练工作台: http://127.0.0.1:${wb.port}`);
console.log(`  runsDir=${runsDir}`);
console.log(`  scenariosDir=${scenariosDir}`);
console.log(`  appPath=${appPath}`);
console.log("Ctrl+C 退出。");
