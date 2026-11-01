/**
 * Narrowing of what the server sends. The page never casts a parsed answer: each reader below checks one member and throws
 * a `ShapeError` that names it, so an answer of an unexpected shape stops at the door of the page with a message of its own
 * and never reaches a view as a wrong type. The parsers of the answers (`model.ts`) are built from these.
 */

/** An answer that does not have the shape the contract promises. */
export class ShapeError extends Error {
  constructor(where: string, expected: string) {
    super(`${where}: expected ${expected}`);
    this.name = 'ShapeError';
  }
}

/** A plain object: not null, not an array. */
export type Obj = Record<string, unknown>;

/** The value as an object, or a `ShapeError` naming `where`. */
export function asObject(value: unknown, where: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShapeError(where, 'an object');
  }
  return Object.fromEntries(Object.entries(value));
}

/** The value as an array, or a `ShapeError`. */
export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ShapeError(where, 'an array');
  }
  return value;
}

/** The value as a string, or a `ShapeError`. */
export function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new ShapeError(where, 'a string');
  }
  return value;
}

/** The value as a finite number, or a `ShapeError`. */
export function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ShapeError(where, 'a number');
  }
  return value;
}

/** The value as a boolean, or a `ShapeError`. */
export function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ShapeError(where, 'a boolean');
  }
  return value;
}

/** A string or null. */
export function asNullableString(value: unknown, where: string): string | null {
  return value === null ? null : asString(value, where);
}

/** A number or null. */
export function asNullableNumber(value: unknown, where: string): number | null {
  return value === null ? null : asNumber(value, where);
}

/** The member `key` of an object, for the readers above to narrow; a missing member reads as `undefined` and fails there. */
export function member(object: Obj, key: string): unknown {
  return object[key];
}

/** Maps every element of an array member through `read`, naming the index in the error. */
export function mapArray<T>(value: unknown, where: string, read: (item: unknown, at: string) => T): T[] {
  return asArray(value, where).map((item, index) => read(item, `${where}[${index}]`));
}
