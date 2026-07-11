export function createMemo() {
  const values = new Map<string, unknown>()

  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    return values.get(key) as T
  }
}
