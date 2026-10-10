/** Shared teardown helpers for the acceptance scripts (方案 §0 审查方法 3:
 * 退出码即契约 —— 一个脚本的结论是对的、退出码却是 1，等于说谎)。
 *
 * Windows keeps a temp tree locked for a moment after its child processes die
 * (Chromium/应用/服务器句柄释放需要时间)，因此清理必须是「等子进程退出 + 重试」，
 * 且清理失败**不得**把成功改写成失败：调用方自行决定是否把残留当失败。
 */
import fsp from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until a child process has really exited (or the timeout elapses). */
export async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Kill a child (SIGTERM then best effort) and wait for it to be gone. */
export async function shutdown(child, timeoutMs = 5000) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  await waitForExit(child, timeoutMs);
}

/** Remove a temp tree, retrying through transient Windows locks.
 * Returns true when the tree is gone. */
export async function removeTempDir(dir, { attempts = 15, delayMs = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(delayMs);
    }
  }
  return false;
}
