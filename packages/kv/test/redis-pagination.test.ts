import { expect, it, vi } from "vitest"

import { createPortableRedisKeyLister } from "../src/runtime/redis-shared.ts"

it("follows each returned SCAN cursor while deleting pages across server instances", async () => {
  // COUNT can cross more buckets after deletion. Replaying cursor 0 would skip a and b after filtering on m.
  const remaining = new Set(["m", "n", "a", "b"])
  const scan = vi.fn(async (cursor: string): Promise<[string, string[]]> => {
    if (cursor === "1") return ["0", ["a", "b"].filter(key => remaining.has(key))]
    return remaining.has("m") ? ["1", ["m", "n"]] : ["0", ["n", "a", "b"].filter(key => remaining.has(key))]
  })
  const keys: string[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const list = createPortableRedisKeyLister("Redis", scan)
    const page = await list({ limit: 1, ...(cursor ? { cursor } : {}) })
    expect(page.keys.length).toBeLessThanOrEqual(1)
    keys.push(...page.keys)
    for (const key of page.keys) remaining.delete(key)
    cursor = page.cursor
    if (!cursor) break
  }
  expect(remaining.size).toBe(0)
  expect(keys.sort()).toEqual(["a", "b", "m", "n"])
  expect(scan.mock.calls.map(([position]) => position)).toEqual(["0", "1"])
})
