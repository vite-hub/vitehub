export default function isBuffer(value: unknown): boolean {
  const constructor = Reflect.get(Object(value), "constructor")
  const candidate = Reflect.get(Object(constructor), "isBuffer")
  return typeof candidate === "function" && Reflect.apply(candidate, constructor, [value]) === true
}
