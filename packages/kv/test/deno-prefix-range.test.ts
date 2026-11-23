import { afterEach, describe, expect, it } from "vitest"

import createDenoKVDriver from "../src/runtime/deno-kv.ts"

type Key = [string]
type Selector = { prefix: [], start?: Key, end?: Key } | { start: Key, end: Key }

const encoder = new TextEncoder()

function compare(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

function denoKV(keys: string[]) {
  const sorted = [...keys].sort(compare)
  const reads: string[][] = []
  const kv = {
    delete: async ([key]: Key) => {
      const index = sorted.indexOf(key)
      if (index !== -1) sorted.splice(index, 1)
    },
    list(selector: Selector, options: { cursor?: string, limit?: number } = {}) {
      const after = options.cursor ? decodeURIComponent(options.cursor) : undefined
      const page: string[] = []
      let cursor = ""
      for (const key of sorted) {
        if (after !== undefined && compare(key, after) <= 0) continue
        if (selector.start && compare(key, selector.start[0]) < 0) continue
        if (selector.end && compare(key, selector.end[0]) >= 0) continue
        if (options.limit !== undefined && page.length === options.limit) break
        page.push(key)
        cursor = encodeURIComponent(key)
      }
      if (options.limit === undefined || page.length < options.limit) cursor = ""
      reads.push(page)
      return Object.assign((async function* () {
        for (const key of page) yield { key: [key], value: "x", versionstamp: "1" }
      })(), { cursor })
    },
  }
  return { kv, reads, sorted }
}

function install(kv: unknown) {
  // SAFETY: The test supplies the Deno KV methods that the adapter calls.
  ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = { openKv: async () => kv }
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { Deno?: unknown }).Deno
})

describe("Deno KV prefix listing", () => {
  const others = Array.from({ length: 50 }, (_, index) => `a:${String(index).padStart(3, "0")}`)
  const users = ["users:1", "users:10", "users:2", "users:\u{1F600}", "users:\u{10FFFF}z"]
  const near = ["user", "usera", "users;", "users;x"]

  it("returns full pages of matching keys without reading other keys", async () => {
    const { kv, reads } = denoKV([...others, ...near, ...users])
    install(kv)
    const driver = createDenoKVDriver()

    const keys: string[] = []
    let pages = 0
    let cursor: string | undefined
    do {
      const page = await driver.listKeys({ cursor, limit: 2, prefix: "users:" })
      keys.push(...page.keys)
      cursor = page.cursor
      pages++
    } while (cursor)

    expect(keys).toEqual(["users:1", "users:10", "users:2", "users:\u{1F600}", "users:\u{10FFFF}z"])
    expect(pages).toBe(3)
    expect(reads.flat()).toEqual(keys)
  })

  it("reads and clears only the keys under a prefix", async () => {
    const { kv, reads, sorted } = denoKV([...others, ...near, ...users])
    install(kv)
    const driver = createDenoKVDriver()

    await expect(driver.getKeys("users:", {})).resolves.toEqual([...users].sort())
    expect(reads.flat()).toEqual(users.toSorted(compare))
    await driver.clear?.("users:", {})
    expect(sorted).toEqual([...others, ...near].sort(compare))
  })

  it.each([
    ["\u{10FFFF}", ["\u{10FFFF}", "\u{10FFFF}a"]],
    ["a\u{10FFFF}", ["a\u{10FFFF}", "a\u{10FFFF}b"]],
    ["퟿", ["퟿", "퟿x"]],
  ])("lists the keys under prefix %j", async (prefix, expected) => {
    const { kv } = denoKV(["a", "b", "", ...expected])
    install(kv)

    await expect(createDenoKVDriver().listKeys({ limit: 10, prefix })).resolves.toEqual({ keys: expected })
  })
})
