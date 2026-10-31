/**
 * Serialises a value with the keys of every object sorted, so equal data always gives equal text. It is the one place the
 * hash of a request (the replay adapter's file name) and the hash of a wire schema (stored with every extraction) are
 * made from, which keeps the two from drifting apart.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
