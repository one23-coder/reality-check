/** Run error taxonomy. Config errors map to exit 64 before any run starts;
 * blocked conditions produce verdict "blocked" (exit 3), never an exception;
 * kernel faults map to exit 70. 方案 §10: a verdict is never an exception. */

export type RunErrorKind = "config" | "internal";

export class RunError extends Error {
  readonly kind: RunErrorKind;
  readonly exitCode: 64 | 70;

  constructor(kind: RunErrorKind, message: string) {
    super(`[${kind}] ${message}`);
    this.name = "RunError";
    this.kind = kind;
    this.exitCode = kind === "config" ? 64 : 70;
  }
}

export function configError(message: string): RunError {
  return new RunError("config", message);
}

export function internalError(message: string, cause?: unknown): RunError {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new RunError("internal", `${message}${detail}`);
}

export function isRunError(e: unknown): e is RunError {
  return e instanceof RunError;
}
