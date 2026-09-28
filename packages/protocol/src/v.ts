/** Minimal strict JSON validator with precise error paths.
 *
 * Hand-rolled on purpose: config errors must be attributable (exit 64),
 * BOM must be rejected (docs/工程方案 §0: "BOM JSON 拒收"), duplicate keys rejected.
 */
export class VError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VError";
  }
}

export type Obj = Record<string, unknown>;

export type V<T> = (value: unknown, path: string) => T;

export const vString: V<string> = (value, path) => {
  if (typeof value !== "string") throw new VError(`${path}: expected string, got ${typeof value}`);
  if (value.length === 0) throw new VError(`${path}: expected non-empty string`);
  return value;
};

export const vBool: V<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new VError(`${path}: expected boolean`);
  return value;
};

export const vInt =
  (opts: { min?: number; max?: number } = {}): V<number> =>
  (value, path) => {
    if (typeof value !== "number" || !Number.isInteger(value))
      throw new VError(`${path}: expected integer, got ${JSON.stringify(value)}`);
    if (opts.min !== undefined && value < opts.min)
      throw new VError(`${path}: expected >= ${opts.min}, got ${value}`);
    if (opts.max !== undefined && value > opts.max)
      throw new VError(`${path}: expected <= ${opts.max}, got ${value}`);
    return value;
  };

export const vEnum =
  <T extends string>(values: readonly T[]): V<T> =>
  (value, path) => {
    const s = vString(value, path);
    if (!(values as readonly string[]).includes(s))
      throw new VError(`${path}: expected one of [${values.join("|")}], got "${s}"`);
    return s as T;
  };

export const vLiteral =
  (expected: string): V<string> =>
  (value, path) => {
    const s = vString(value, path);
    if (s !== expected) throw new VError(`${path}: expected "${expected}", got "${s}"`);
    return s;
  };

export const vArray =
  <T>(item: V<T>, opts: { min?: number; max?: number } = {}): V<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) throw new VError(`${path}: expected array`);
    if (opts.min !== undefined && value.length < opts.min)
      throw new VError(`${path}: expected at least ${opts.min} items`);
    if (opts.max !== undefined && value.length > opts.max)
      throw new VError(`${path}: expected at most ${opts.max} items`);
    const seen = new Set<string>();
    return value.map((el, i) => {
      const out = item(el, `${path}[${i}]`);
      if (typeof out === "string" && out.startsWith("id:")) {
        if (seen.has(out)) throw new VError(`${path}[${i}]: duplicate id ${out}`);
        seen.add(out);
      }
      return out;
    });
  };

/** Object validator. Unknown keys are rejected (fail closed on typo'd fields). */
export const vObject =
  <T>(spec: { required: Record<string, V<unknown>>; optional?: Record<string, V<unknown>> }): V<T> =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new VError(`${path}: expected object`);
    const obj = value as Obj;
    const out: Obj = {};
    for (const [k, check] of Object.entries(spec.required)) {
      if (!(k in obj)) throw new VError(`${path}.${k}: missing required field`);
      out[k] = check(obj[k], `${path}.${k}`);
    }
    for (const [k, check] of Object.entries(spec.optional ?? {})) {
      if (k in obj && obj[k] !== undefined) out[k] = check(obj[k], `${path}.${k}`);
    }
    const allowed = new Set([...Object.keys(spec.required), ...Object.keys(spec.optional ?? {})]);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) throw new VError(`${path}.${k}: unknown field`);
    }
    return out as T;
  };

export const vRecord =
  <T>(item: V<T>): V<Record<string, T>> =>
  (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new VError(`${path}: expected object`);
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(value)) out[k] = item(v, `${path}.${k}`);
    return out;
  };

/** Parse JSON text; rejects BOM explicitly (工程方案 §3.1: BOM JSON 必须被拒).
 * Note: JSON.parse silently overwrites duplicate keys, so duplicate-key rejection
 * is NOT claimed here. */
export function parseJsonStrict(text: string, source: string): unknown {
  if (text.charCodeAt(0) === 0xfeff)
    throw new VError(`${source}: UTF-8 BOM detected; strip BOM before parsing`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new VError(`${source}: invalid JSON (${(e as Error).message})`);
  }
}
