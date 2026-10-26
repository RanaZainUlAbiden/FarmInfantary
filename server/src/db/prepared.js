// Server-only capability. JSON, structuredClone and HTTP bodies cannot mint or
// preserve this WeakMap identity. Guarded SQL is executed exactly as deparsed,
// without another dialect/placeholder/RETURNING transformation.
const queries = new WeakMap();
export function sealPrepared({ text, parameterCount, idColumn = null, rowLimit = null }) {
  const handle = Object.freeze({});
  queries.set(handle, Object.freeze({ text, parameterCount, idColumn, rowLimit, resync: null }));
  return handle;
}
export const readPrepared = handle => handle && typeof handle === 'object' ? queries.get(handle) : undefined;
