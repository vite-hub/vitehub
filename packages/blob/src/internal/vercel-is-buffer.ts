export default function isBuffer(value: unknown): boolean {
  const constructor = Reflect.get(Object(value), "constructor")
  const candidate = Reflect.get(Object(constructor), "isBuffer")
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Third-party Buffer implementations expose this callable structural contract.
  return typeof candidate === "function" && Reflect.apply(candidate, constructor, [value]) === true
}
