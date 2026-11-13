import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { Redis as UpstashRedis } from "@upstash/redis"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createCloudflareKVStorage } from "../src/runtime/cloudflare-kv.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"
import createRedisKVDriver from "../src/runtime/redis-driver.ts"
import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"

const redis = vi.hoisted(() => ({ values: new Map<string, string>(), commands: [] as string[] }))

vi.mock("ioredis", () => ({
  Redis: class {
    get = async (key: string) => redis.values.get(key) ?? null
    set = async (key: string, value: string) => { redis.values.set(key, value); return "OK" }
    unlink = async (...keys: string[]) => {
      redis.commands.push("unlink")
      for (const key of keys) redis.values.delete(key)
      return keys.length
    }
    scan = async (cursor: string, _match: string, pattern: string, _count: string, count: number): Promise<[string, string[]]> => {
      redis.commands.push("scan")
      const keys = [...redis.values.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))
      const next = Number(cursor) + count
      return [next < keys.length ? String(next) : "0", keys.slice(Number(cursor), next)]
    }
    disconnect() {}
  },
}))

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
  redis.values.clear()
  redis.commands.length = 0
})

const cleared = Array.from({ length: 1200 }, (_, index) => `a:${index}`).concat("a:nested:key")
const kept = ["a", "ab", "ab:key", "abc:key", "b:a:key"]

/** A store and the number of provider calls that delete keys. */
interface Target {
  storage: RuntimeStorage
  deletes: () => number
}

/** Upstash REST commands, answered from a Map with Upstash's base64 response encoding. */
function stubUpstashRest(commands: string[]) {
  const values = new Map<string, string>()
  const encode = (value: unknown): unknown => typeof value === "string" ? Buffer.from(value).toString("base64") : Array.isArray(value) ? value.map(encode) : value
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    // SAFETY: The Upstash client sends one JSON command array per request when auto pipelining is off.
    const [command, ...args] = JSON.parse(String(init.body)) as string[]
    const name = command!.toLowerCase()
    commands.push(name)
    if (name === "set") {
      values.set(args[0]!, args[1]!)
      return Response.json({ result: "OK" })
    }
    if (name === "unlink" || name === "del") {
      for (const key of args) values.delete(key)
      return Response.json({ result: args.length })
    }
    if (name === "get") return Response.json({ result: encode(values.get(args[0]!) ?? null) })
    if (name === "scan") {
      const cursor = Number(args[0])
      const match = args[args.indexOf("match") + 1]!
      const countIndex = args.indexOf("count")
      const count = countIndex === -1 ? 10 : Number(args[countIndex + 1])
      const keys = [...values.keys()].filter(key => match === "*" || key.startsWith(match.slice(0, -1)))
      const next = cursor + count
      return Response.json({ result: encode([next < keys.length ? String(next) : "0", keys.slice(cursor, next)]) })
    }
    throw new Error(`Unexpected Upstash command: ${name}`)
  }))
}

const targets: Record<string, () => Promise<Target>> = {
  async redis() {
    const storage = createKVStorage(createRedisKVDriver({ driver: "redis", base: "store", url: "redis://localhost" })) as unknown as RuntimeStorage
    return { storage, deletes: () => redis.commands.filter(command => command === "unlink").length }
  },
  async upstash() {
    const commands: string[] = []
    stubUpstashRest(commands)
    const driver = createUpstashKVDriver({ driver: "upstash", token: "test", url: "https://example.com", enableAutoPipelining: false, lib: { Redis: UpstashRedis } } as Parameters<typeof createUpstashKVDriver>[0])
    const storage = createKVStorage(driver) as unknown as RuntimeStorage
    return { storage, deletes: () => commands.filter(command => command === "unlink" || command === "del").length }
  },
  async database() {
    const client = createClient({ url: ":memory:" })
    cleanups.push(async () => client.close())
    let deletes = 0
    const execute = client.execute.bind(client)
    const counted = Object.assign(Object.create(client) as object, {
      execute: (statement: { sql: string }) => {
        if (/^\s*delete from/i.test(statement.sql) && !statement.sql.includes("expires_at <=")) deletes++
        return execute(statement)
      },
    })
    const storage = createHostedKVStorage({ store: { driver: "database", database: "default", namespace: `clear-${randomUUID()}` } }, "default", async () => ({ default: { db: { $client: counted } } }))
    return { storage, deletes: () => deletes }
  },
  async "fs-lite"() {
    const base = await mkdtemp(join(tmpdir(), "vitehub-kv-clear-fs-"))
    cleanups.push(() => rm(base, { force: true, recursive: true }))
    return { storage: createHostedKVStorage({ store: { driver: "fs-lite", base } }), deletes: () => 0 }
  },
  async cloudflare() {
    const values = new Map<string, string>()
    let deletes = 0
    const binding = {
      delete: async (key: string) => { deletes++; values.delete(key) },
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      list: async ({ prefix = "", cursor }: { prefix?: string, cursor?: string }) => {
        const keys = [...values.keys()].filter(key => key.startsWith(prefix))
        const offset = Number(cursor ?? 0)
        const next = offset + 1000
        return { keys: keys.slice(offset, next).map(name => ({ name })), list_complete: next >= keys.length, cursor: String(next) }
      },
    }
    // SAFETY: The Cloudflare factory supplies the RuntimeStorage methods.
    return { storage: createCloudflareKVStorage({ binding }) as RuntimeStorage, deletes: () => deletes }
  },
}

/** The most delete calls each driver may make for 1201 keys. */
const deleteBudget: Record<string, number> = {
  "redis": 2,
  "upstash": 2,
  "database": 1,
  // fs-lite deletes local files; the check is that clear() keeps keys outside the base.
  "fs-lite": 0,
  // Workers KV bindings have no batch delete, so each key is one call.
  "cloudflare": cleared.length,
}

describe.each(Object.keys(targets))("%s clear(base)", (name) => {
  it("deletes keys under the base in batches and keeps sibling prefixes", { timeout: 60_000 }, async () => {
    const { storage, deletes } = await targets[name]!()
    cleanups.push(() => storage.dispose())
    for (const key of [...cleared, ...kept]) await storage.setItem(key, "value")
    const before = deletes()

    await storage.clear("a")

    expect(deletes() - before).toBeLessThanOrEqual(deleteBudget[name]!)
    expect((await storage.getKeys()).sort()).toEqual([...kept].sort())
  })
})
