import { afterEach, describe, expect, it } from "vitest"

import createDenoKVDriver from "../src/runtime/deno-kv.ts"

type Key = [string]
type Selector = { prefix: [], start?: Key }

const encoder = new TextEncoder()

function compare(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

function encodedSize(key: string): number {
  return 2 + encoder.encode(key).length + key.split("\0").length - 1
}

function denoKV(keys: string[]) {
  const sorted = [...keys].sort(compare)
  const reads: string[][] = []
  const calls: Array<{ selector: Selector, cursor?: string }> = []
  const kv = {
    delete: async ([key]: Key) => {
      const index = sorted.indexOf(key)
      if (index !== -1) sorted.splice(index, 1)
    },
    list(selector: Selector, options: { cursor?: string, limit?: number } = {}) {
      calls.push({ selector, cursor: options.cursor })
      if (selector.start && encodedSize(selector.start[0]) > 2_049) throw new TypeError("Key too large for read (max 2049 bytes)")
      const after = options.cursor ? decodeURIComponent(options.cursor) : undefined
      if (after !== undefined && selector.start && compare(after, selector.start[0]) < 0) throw new TypeError("cursor out of bounds")
      const page = sorted.filter(key => (after === undefined || compare(key, after) > 0) && (!selector.start || compare(key, selector.start[0]) >= 0)).slice(0, options.limit)
      const read: string[] = []
      reads.push(read)
      const full = options.limit !== undefined && page.length === options.limit
      return Object.assign((async function* () {
        for (const key of page) {
          read.push(key)
          yield { key: [key], value: "x", versionstamp: "1" }
        }
      })(), { cursor: full ? encodeURIComponent(page.at(-1)!) : "" })
    },
  }
  return { calls, kv, reads, sorted }
}

function install(kv: unknown) {
  // SAFETY: The test supplies the Deno KV methods that the adapter calls.
  ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = { openKv: async () => kv }
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { Deno?: unknown }).Deno
})

async function listAll(driver: ReturnType<typeof createDenoKVDriver>, prefix: string, limit: number, cursor?: string) {
  const keys: string[] = []
  let pages = 0
  do {
    const page = await driver.listKeys({ cursor, limit, prefix })
    keys.push(...page.keys)
    cursor = page.cursor
    pages++
  } while (cursor)
  return { keys, pages }
}

describe("Deno KV prefix listing", () => {
  const others = Array.from({ length: 50 }, (_, index) => `a:${String(index).padStart(3, "0")}`)
  const users = ["users:1", "users:10", "users:2", "users:\u{1F600}", "users:\u{10FFFF}z"]
  const near = ["user", "usera", "users;", "users;x"]

  it("returns full pages of matching keys and stops at the first key after the prefix", async () => {
    const { calls, kv, reads } = denoKV([...others, ...near, ...users])
    install(kv)

    const { keys, pages } = await listAll(createDenoKVDriver(), "users:", 2)

    expect(keys).toEqual(["users:1", "users:10", "users:2", "users:\u{1F600}", "users:\u{10FFFF}z"])
    expect(pages).toBe(3)
    expect(reads.flat()).toEqual([...keys, "users;"])
    expect(calls.map(call => call.selector)).toEqual([{ prefix: [], start: ["users:"] }, { prefix: [] }, { prefix: [] }])
  })

  it("continues a cursor that the earlier full-scan driver issued", async () => {
    const { kv } = denoKV([...others, ...near, ...users])
    install(kv)

    const { keys } = await listAll(createDenoKVDriver(), "users:", 4, encodeURIComponent("a:049"))

    expect(keys).toEqual(users.toSorted(compare))
  })

  it("reads and clears only the keys under a prefix", async () => {
    const { kv, reads, sorted } = denoKV([...others, ...near, ...users])
    install(kv)
    const driver = createDenoKVDriver()

    await expect(driver.getKeys("users:", {})).resolves.toEqual([...users].sort())
    expect(reads.flat()).toEqual([...users.toSorted(compare), "users;"])
    await driver.clear?.("users:", {})
    expect(sorted).toEqual([...others, ...near].sort(compare))
  })

  it.each([
    ["\u{10FFFF}", ["\u{10FFFF}", "\u{10FFFF}a"]],
    ["a\u{10FFFF}", ["a\u{10FFFF}", "a\u{10FFFF}b"]],
    ["퟿", ["퟿", "퟿x"]],
    ["x".repeat(2_046), ["x".repeat(2_046)]],
  ])("lists the keys under prefix %#", async (prefix, expected) => {
    const { kv } = denoKV(["a", "b", "", "\u{E000}", ...expected])
    install(kv)

    await expect(createDenoKVDriver().listKeys({ limit: 10, prefix })).resolves.toEqual({ keys: expected })
  })

  it.each(["x".repeat(2_047), "\0".repeat(1_024)])("returns no keys for prefix %# that no stored key can hold", async (prefix) => {
    const { calls, kv } = denoKV(["a", "x".repeat(2_046)])
    install(kv)
    const driver = createDenoKVDriver()

    await expect(driver.listKeys({ limit: 10, prefix })).resolves.toEqual({ keys: [] })
    await expect(driver.getKeys(prefix, {})).resolves.toEqual([])
    await expect(driver.clear?.(prefix, {})).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
})
