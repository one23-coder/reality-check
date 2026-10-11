/** A runId is ONE path segment under `runsDir` — never a path.
 *
 * It arrives from a user flag (CLI) or a network-facing tool (MCP) and is then
 * joined onto `runsDir`; in `export --pack` the joined path is **recursively
 * deleted** before being rewritten. `..` there is not a typo, it is a destructive
 * path traversal. The MCP side already guarded this; the CLI side did not, so
 * `export --run-id ../../anything --pack out` both read an arbitrary
 * `result.json` from disk and `rm -rf`'d a directory outside `--pack`.
 *
 * Shared here (single source) so every entrance enforces the same shape and the
 * same message.
 */

/** Returns the reason this runId is unusable, or null when it is safe. */
export function runIdProblem(runId: unknown): string | null {
  if (typeof runId !== "string" || runId === "") return "run id must be a non-empty string";
  const shown = JSON.stringify(runId);
  if (runId === "." || runId === "..") return `invalid run id ${shown}: must not be a relative path`;
  if (/[/\\]/.test(runId)) return `invalid run id ${shown}: must be a single path segment (no / or \\)`;
  if (!/^[A-Za-z0-9._-]+$/.test(runId))
    return `invalid run id ${shown}: allowed characters are letters, digits, ".", "_" and "-"`;
  return null;
}

export function isSafeRunId(runId: unknown): boolean {
  return runIdProblem(runId) === null;
}