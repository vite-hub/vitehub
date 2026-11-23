import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { STATE_DATABASE_NOW } from "../src/internal/state-database-clock.ts"

const { createClient } = await vi.importActual<typeof import("@libsql/client")>("@libsql/client")

const sqldUrl = process.env.VITEHUB_SQLD_URL
const worker = fileURLToPath(new URL("./support/state-clock-worker.ts", import.meta.url))
const ttlMs = 1_500
const skewMs = 5 * 60_000
const scope = "webhook:clock:github:"

interface Host {
  call: (method: string, ...args: unknown[]) => Promise<unknown>
  process: ChildProcess
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startHost(url: string, tablePrefix: string, skew: number): Promise<Host> {
  const child = fork(worker, [], {
    env: { ...process.env, HOST_SKEW_MS: String(skew), STATE_TABLE_PREFIX: tablePrefix, STATE_URL: url },
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  cleanups.push(async () => {
    if (child.exitCode !== null) return
    const exited = new Promise(resolve => child.once("exit", resolve))
    child.disconnect()
    await exited
  })
  const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>()
  let nextId = 0
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", code => reject(new Error(`State host exited with ${code}`)))
    child.on("message", (message: { error?: string; id?: number; ready?: true; value?: unknown }) => {
      if (message.ready) return resolve()
      const call = pending.get(message.id!)
      pending.delete(message.id!)
      if (message.error) call?.reject(new Error(message.error))
      else call?.resolve(message.value)
    })
  })
  return {
    call: (method, ...args) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { reject, resolve })
      child.send({ args, id, method })
    }),
    process: child,
  }
}

function delivery(deliveryId: string) {
  return {
    concurrencyGroup: "clock",
    concurrencyLimit: 1,
    deliveryId,
    enqueuedAt: { hostIn: 0 },
    leaseTtlMs: ttlMs,
    request: { body: "{}", headers: {}, method: "POST", url: "https://example.com/hook" },
    scope,
    webhookId: "github",
  }
}

const backends = [
  { name: "local SQLite", url: async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-state-clock-"))
    cleanups.push(() => rm(dir, { force: true, recursive: true }))
    return `file:${join(dir, "state.db")}`
  } },
  { name: "sqld", skip: !sqldUrl, url: async () => sqldUrl! },
]

describe.each(backends)("Agent State on the database clock ($name)", ({ skip, url: createUrl }) => {
  it.skipIf(skip)("expires entries when the database says, from two hosts with skewed clocks", { timeout: 60_000 }, async () => {
    const url = await createUrl()
    const tablePrefix = `clock_${process.pid}_${Date.now()}_`
    const database = createClient({ url })
    cleanups.push(async () => {
      const tables = await database.execute({ args: [`${tablePrefix}%`], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?" })
      for (const row of tables.rows) await database.execute(`DROP TABLE IF EXISTS "${String(row.name)}"`)
      database.close()
    })
    const databaseNow = async () => Number((await database.execute(`SELECT ${STATE_DATABASE_NOW} AS now`)).rows[0]!.now)

    const ahead = await startHost(url, tablePrefix, skewMs)
    const behind = await startHost(url, tablePrefix, -skewMs)
    const entry = { enqueuedAt: { hostIn: 0 }, expiresAt: { hostIn: ttlMs }, message: { text: "queued" } }

    const writtenFrom = await databaseNow()
    await ahead.call("set", "cache-ahead", "a", ttlMs)
    await behind.call("set", "cache-behind", "b", ttlMs)
    await behind.call("setIfNotExists", "once-behind", "b", ttlMs)
    await ahead.call("acquireLock", "lock-ahead", ttlMs)
    await behind.call("acquireLock", "lock-behind", ttlMs)
    await ahead.call("appendToList", "list-ahead", "a", { ttlMs })
    await behind.call("appendToList", "list-behind", "b", { ttlMs })
    await ahead.call("enqueue", "queue-ahead", entry, 10)
    await behind.call("enqueue", "queue-behind", entry, 10)
    await behind.call("enqueueWebhookDelivery", delivery("delivery-behind"))
    expect(await behind.call("claimWebhookDelivery", scope)).toMatchObject({ attempts: 0, deliveryId: "delivery-behind" })
    const writtenTo = await databaseNow()

    const expiries = (await database.execute(`
      SELECT 'cache' AS kind, expires_at FROM ${tablePrefix}cache
      UNION ALL SELECT 'lock', expires_at FROM ${tablePrefix}locks
      UNION ALL SELECT 'list', expires_at FROM ${tablePrefix}lists
      UNION ALL SELECT 'queue', expires_at FROM ${tablePrefix}queue
      UNION ALL SELECT 'lease', lease_expires_at FROM ${tablePrefix}webhook_queue`)).rows
    expect(expiries.map(row => row.kind).sort()).toEqual(["cache", "cache", "cache", "lease", "list", "list", "lock", "lock", "queue", "queue"])
    for (const row of expiries) {
      expect(Number(row.expires_at)).toBeGreaterThanOrEqual(writtenFrom + ttlMs - 50)
      expect(Number(row.expires_at)).toBeLessThanOrEqual(writtenTo + ttlMs)
    }

    expect(await ahead.call("get", "cache-behind")).toBe("b")
    expect(await behind.call("get", "cache-ahead")).toBe("a")
    expect(await ahead.call("setIfNotExists", "once-behind", "a", ttlMs)).toBe(false)
    expect(await ahead.call("acquireLock", "lock-behind", ttlMs)).toBeNull()
    expect(await behind.call("acquireLock", "lock-ahead", ttlMs)).toBeNull()
    expect(await ahead.call("getList", "list-behind")).toEqual(["b"])
    expect(await behind.call("getList", "list-ahead")).toEqual(["a"])
    expect(await ahead.call("queueDepth", "queue-behind")).toBe(1)
    expect(await behind.call("queueDepth", "queue-ahead")).toBe(1)
    expect(await ahead.call("claimWebhookDelivery", scope)).toBeNull()
    expect(await databaseNow()).toBeLessThan(writtenFrom + ttlMs - 50)

    const longLived = { ...entry, expiresAt: { hostIn: 60_000 } }
    await behind.call("enqueue", "rewrite", longLived, 10)
    await behind.call("enqueue", "rewrite", { ...longLived, message: { text: "retained" } }, 10)
    const storedTailExpiry = async () => (await database.execute(`SELECT expires_at FROM ${tablePrefix}queue WHERE thread_id = 'rewrite' ORDER BY id DESC LIMIT 1`)).rows[0]?.expires_at
    const beforeRewrite = await storedTailExpiry()
    const head = await ahead.call("queuePeek", "rewrite")
    expect(await ahead.call("queueReplaceHead", "rewrite", head, [], 10)).toBe(true)
    expect.soft(await storedTailExpiry()).toBe(beforeRewrite)
    expect.soft(await ahead.call("queuePeek", "rewrite")).toMatchObject({ message: { text: "retained" } })

    await behind.call("enqueue", "drain", longLived, 10)
    const beforeDrain = await databaseNow()
    const drained = await ahead.call("dequeue", "drain")
    expect.soft(drained).toMatchObject({ expiresAt: expect.any(Number), message: { text: "queued" } })
    if (drained && typeof drained === "object" && "expiresAt" in drained) {
      expect.soft(Number(drained.expiresAt)).toBeGreaterThan(beforeDrain + skewMs)
      expect.soft(Number(drained.expiresAt)).toBeLessThanOrEqual(await databaseNow() + skewMs + 60_000 + 50)
    }

    while (await databaseNow() <= writtenTo + ttlMs) await new Promise(resolve => setTimeout(resolve, 50))
    expect(await ahead.call("get", "cache-behind")).toBeNull()
    expect(await behind.call("get", "cache-ahead")).toBeNull()
    expect(await ahead.call("setIfNotExists", "once-behind", "a", ttlMs)).toBe(true)
    expect(await ahead.call("acquireLock", "lock-behind", ttlMs)).toMatchObject({ threadId: "lock-behind" })
    expect(await behind.call("acquireLock", "lock-ahead", ttlMs)).toMatchObject({ threadId: "lock-ahead" })
    expect(await ahead.call("getList", "list-behind")).toEqual([])
    expect(await behind.call("getList", "list-ahead")).toEqual([])
    expect(await ahead.call("queueDepth", "queue-behind")).toBe(0)
    expect(await behind.call("queueDepth", "queue-ahead")).toBe(0)
    expect(await ahead.call("claimWebhookDelivery", scope)).toMatchObject({ attempts: 1, deliveryId: "delivery-behind" })
  })
})
