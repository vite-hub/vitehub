import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"
import { deleteCacheEntries, getCacheEntry, listCacheEntries } from "../../packages/vite-hub/src/cache/entries.ts"
import type { CacheStorage } from "../../packages/vite-hub/src/cache/entries.ts"
import { consoleErrorResult } from "../../packages/vite-hub/src/console/runtime/server/request.ts"

/**
 * Nitro's `cache` mount, in memory, with keys as Nitro 3 writes them. The real `cache.*` operation code reads it, so the
 * page shows what an app shows. A restart resets it.
 */
const minute = 60_000
const now = Date.now()
const functions = "nitrofunctions.3aFYDY_G88ZLdElv-hEB0r8snSViMYJ1NbRtlNP9o_0"
const handlers = "nitrohandlers.clkdKvJAHUTUPgeJs29cPg7i_-9RJQM_YVW-CrdBbuA"
const items = new Map<string, unknown>([
  [`${functions}:getStars:TL6S2ZKGLcgBWS_j-4H6ehhwxjjUzgC1d4N21pXnDfY.json`, { expires: now + 54 * minute, integrity: "Hk2", mtime: now - 6 * minute, value: { repo: "vite-hub/vitehub", stars: 4182 } }],
  [`${functions}:getStars:WlA9FzLbXkL-JVWijTnvCi0ZzZ1i86JsCRWWSbeLxyM.json`, { expires: now - 3 * minute, integrity: "Hk2", mtime: now - 63 * minute, value: { repo: "nuxt/nuxt", stars: 57940 } }],
  [`${functions}:pricing:Rf0cT2lQm8Yd5sWv3pN1xK7hB9gJ4uE6aZ0oC2iL5yM.json`, { expires: now + 22 * 60 * minute, integrity: "Pq8", mtime: now - 2 * 60 * minute, value: { currency: "EUR", plans: [{ id: "hobby", price: 0 }, { id: "pro", price: 20 }, { id: "team", price: 99 }] } }],
  [`${functions}:locale:3ac9d4Qy0b1mN7sPz2kVt8xR5wL4eH6jU9cF1gD2aB0.json`, { integrity: "Xy1", mtime: now - 3 * 24 * 60 * minute, value: "en-US" }],
  [`${handlers}:posts:posts.S8IZMUovHv2pRMDnFzsM12UbRl8HKKrreeyC2RMeY8E.json`, { expires: now + 4 * minute, integrity: "Ab3", mtime: now - minute, value: { body: JSON.stringify([{ id: 1, title: "Hello ViteHub" }, { id: 2, title: "Cache in the Console" }]), headers: { "content-type": "application/json" }, status: 200 } }],
  [`${handlers}:products:apiproducts.c41fQ2mZ0vH7sLk9pR3tW8yB6nD1xE5gJ4aU2oI7eY.json`, { expires: now + 9 * minute, integrity: "Ab3", mtime: now - 51_000, value: { body: JSON.stringify({ items: Array.from({ length: 24 }, (_, index) => ({ id: 25 + index, name: `Product ${25 + index}` })), page: 2 }), headers: { "content-type": "application/json" }, status: 200 } }],
])

const storage: CacheStorage = {
  getItem: async key => items.get(key) ?? null,
  getKeys: async (base = "") => [...items.keys()].filter(key => !base || key.startsWith(`${base.replace(/:$/, "")}:`)),
  hasItem: async key => items.has(key),
  removeItem: async (key) => { items.delete(key) },
}

/** Answers a `cache.*` operation with the real operation code, or undefined for any other operation. */
export async function cacheFixture(operation: string, input: Record<string, unknown>): Promise<ConsoleRpcResult | undefined> {
  const run = {
    "cache.delete": () => deleteCacheEntries(storage, input),
    "cache.get": () => getCacheEntry(storage, { key: String(input.key ?? "") }),
    "cache.list": () => listCacheEntries(storage, input),
  }[operation]
  if (!run) return undefined
  try {
    return { ok: true, value: await run() }
  }
  catch (error) {
    return consoleErrorResult(error)
  }
}
