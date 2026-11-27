/** Returns a plain JSON-style object, or undefined for primitives, arrays, and functions. */
export function runtimeRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || Object(value) !== value || Array.isArray(value)) return;
  if (Object.prototype.toString.call(value) !== "[object Object]") return;
  // SAFETY: A non-array object with the Object tag exposes string-keyed properties of unknown type.
  return value as Readonly<Record<string, unknown>>;
}
