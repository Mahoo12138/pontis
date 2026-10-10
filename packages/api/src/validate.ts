// Runtime checks for the response shapes declared in ./types.
//
// The Go server is the source of truth and `fixtures/api/` holds the bodies it
// really emits. Before this file, `client` did `res.json() as T`: the cast
// silences the compiler and changes nothing at runtime, so a `null` where a
// component iterates an array — the exact failure that broke the extension's
// /sync consumer — arrives as a blank page instead of as an error.

/** Validates one value, or throws ContractViolation naming where it failed. */
export type Checker<T> = (value: unknown, at: string) => T;

export class ContractViolation extends Error {
  override readonly name = 'ContractViolation';

  constructor(
    readonly at: string,
    readonly expected: string,
    readonly received: unknown,
  ) {
    super(
      `API contract violated at ${at || 'body'}: expected ${expected}, received ${preview(received)}`,
    );
  }
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function reject(at: string, expected: string, value: unknown): never {
  throw new ContractViolation(at, expected, value);
}

export const str: Checker<string> = (value, at) =>
  typeof value === 'string' ? value : reject(at, 'a string', value);

export const num: Checker<number> = (value, at) =>
  typeof value === 'number' && Number.isFinite(value) ? value : reject(at, 'a number', value);

export const bool: Checker<boolean> = (value, at) =>
  typeof value === 'boolean' ? value : reject(at, 'a boolean', value);

/** Accepts anything, for objects whose values the client does not read. */
export const unknownValue: Checker<unknown> = (value) => value;

/** A field the server may leave out entirely. */
export function opt<T>(inner: Checker<T>): Checker<T | undefined> {
  return (value, at) => (value === undefined ? undefined : inner(value, at));
}

/** A field the server always sends but may send as `null`. */
export function nullable<T>(inner: Checker<T>): Checker<T | null> {
  return (value, at) => (value === null ? null : inner(value, at));
}

export function arr<T>(item: Checker<T>): Checker<T[]> {
  return (value, at) => {
    if (!Array.isArray(value)) reject(at, 'an array', value);
    return (value as unknown[]).map((entry, i) => item(entry, `${at}[${i}]`));
  };
}

/**
 * A closed set of string values. Naming the members matters: an enum the
 * server extends is a contract change, and a component that switched on the
 * old set would otherwise take its default branch quietly.
 */
export function oneOf<T extends string>(...allowed: [T, ...T[]]): Checker<T> {
  return (value, at) => {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      reject(at, `one of ${allowed.join(' | ')}`, value);
    }
    return value as T;
  };
}

/** An object whose keys are open-ended, e.g. error `details`. */
export function recordOf<T>(item: Checker<T>): Checker<Record<string, T>> {
  return (value, at) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reject(at, 'an object', value);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, T> = {};
    for (const key of Object.keys(source)) out[key] = item(source[key], `${at}.${key}`);
    return out;
  };
}

/**
 * Check every declared key of `T`. Keys the server adds beyond the declaration
 * are passed through untouched: a response may grow a field before the UI
 * learns about it, and dropping it here would break rendering rather than
 * report a problem.
 */
export function record<T extends object>(
  shape: { [K in keyof T]-?: Checker<T[K]> },
): Checker<T> {
  return (value, at) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reject(at, 'an object', value);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...source };
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      out[key] = shape[key](source[key], `${at}.${key}`);
    }
    return out as T;
  };
}
