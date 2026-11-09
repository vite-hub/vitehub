import { decodeRealtimeBusMessage, encodeRealtimeBusMessage } from "./bus-protocol.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

import type { RealtimeBus, RealtimeBusMessage, RealtimeRoomRecord } from "./bus-protocol.ts"

export type { RealtimeBus, RealtimeBusMessage, RealtimeRoomRecord } from "./bus-protocol.ts"

/** The authority that a Node build asks for: `auto` reads the environment when the server starts. */
export type RealtimeNodeAuthority = "auto" | "postgres" | "redis"

/** The variable that points the Postgres bus at its own database, instead of the connection of the Default Database. */
export const realtimePostgresUrlVariable = "REALTIME_POSTGRES_URL"

/** The Databases of the app, as `@vite-hub/database/drizzle` exports them. */
export type RealtimeDatabases = Readonly<Record<string, { db: object } | undefined>>

export interface RealtimeNodeBusOptions {
  /**
   * Loads the Databases of the app. The generated server passes it when the build found the Default Database on
   * Postgres. The bus then uses the postgres.js client of that Database, whatever variable its Definition reads.
   */
  databases?: () => Promise<RealtimeDatabases>
  env?: Record<string, string | undefined>
}

/** Where the rooms of this process live: alone in memory, or shared with other instances over a bus. */
export interface RealtimeNodeAuthorityChoice {
  authority: "memory" | "postgres" | "redis"
  /** What the bus connects with: a variable, or the connection of the Default Database. */
  source?: "REDIS_URL" | typeof realtimePostgresUrlVariable | "Default Database"
  url?: string
}

const postgresUrl = /^postgres(?:ql)?:\/\//i

function readVariable(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim()
  return value || undefined
}

/**
 * Picks the room authority of a Node server: `REDIS_URL` selects Redis. Else `REALTIME_POSTGRES_URL`, or the Default
 * Database when it is on Postgres, selects Postgres. Else the rooms stay in this process. An explicit `postgres` or
 * `redis` requires its connection. `database` is true when the build found the Default Database on Postgres.
 */
export function resolveRealtimeNodeAuthority(
  authority: RealtimeNodeAuthority,
  options: { database?: boolean, env?: Record<string, string | undefined> } = {},
): RealtimeNodeAuthorityChoice {
  const env = options.env ?? globalThis.process?.env ?? {}
  const redis = readVariable(env, "REDIS_URL")
  const override = readVariable(env, realtimePostgresUrlVariable)
  if (authority === "redis" || (authority === "auto" && redis)) {
    if (!redis) throw realtimeErrorDiagnostics.REALTIME_MISSING_BUS_CONNECTION({ authority: "redis" })
    return { authority: "redis", source: "REDIS_URL", url: redis }
  }
  if (override) {
    if (!postgresUrl.test(override)) throw realtimeErrorDiagnostics.REALTIME_INVALID_POSTGRES_URL()
    return { authority: "postgres", source: realtimePostgresUrlVariable, url: override }
  }
  if (options.database) return { authority: "postgres", source: "Default Database" }
  if (authority === "postgres") throw realtimeErrorDiagnostics.REALTIME_MISSING_BUS_CONNECTION({ authority: "postgres" })
  return { authority: "memory" }
}

function describeChoice(choice: RealtimeNodeAuthorityChoice): string {
  return choice.authority === "memory"
    ? "[vitehub] Realtime keeps rooms in this process. Set REDIS_URL, or use a Postgres Default Database, to share rooms across instances."
    : `[vitehub] Realtime shares rooms across instances through ${choice.authority === "redis" ? "Redis" : "Postgres"} (${choice.source}).`
}

/** The postgres.js client of the Default Database, or undefined when it is not one. */
async function defaultDatabaseClient(databases: (() => Promise<RealtimeDatabases>) | undefined): Promise<PostgresClient | undefined> {
  const entry = databases ? (await databases()).default : undefined
  const client: unknown = entry ? Reflect.get(entry.db, "$client") : undefined
  return isPostgresClient(client) ? client : undefined
}

/**
 * Creates the bus for `authority`, or `undefined` when the rooms stay in this process. `useRealtimeBus()` keeps one per
 * process. A bus on the Default Database borrows its client and never closes it.
 */
export async function createRealtimeNodeBus(authority: RealtimeNodeAuthority, options: RealtimeNodeBusOptions = {}): Promise<RealtimeBus | undefined> {
  const choice = resolveRealtimeNodeAuthority(authority, { database: !!options.databases, env: options.env })
  if (choice.authority === "redis") return await createRedisRealtimeBus(choice.url!)
  if (choice.authority === "memory") return undefined
  if (choice.url) return await createPostgresRealtimeBus({ url: choice.url })
  const client = await defaultDatabaseClient(options.databases)
  if (!client) throw realtimeErrorDiagnostics.REALTIME_MISSING_BUS_CONNECTION({ authority: "postgres" })
  return await createPostgresRealtimeBus({ client })
}

const busesKey: unique symbol = Symbol.for("vitehub.realtime.buses")
// SAFETY: This module owns the process slot shared by the separately bundled handler and Nitro plugin.
const busScope = globalThis as typeof globalThis & { [busesKey]?: Map<RealtimeNodeAuthority, Promise<RealtimeBus | undefined>> }

function buses(): Map<RealtimeNodeAuthority, Promise<RealtimeBus | undefined>> {
  busScope[busesKey] ??= new Map()
  return busScope[busesKey]
}

/**
 * The bus of this process for `authority`, created on first use, or `undefined` when the rooms stay in this process.
 * The generated Realtime handler of a Node build calls it.
 */
export function useRealtimeBus(authority: RealtimeNodeAuthority = "auto", options: RealtimeNodeBusOptions = {}): Promise<RealtimeBus | undefined> {
  const existing = buses().get(authority)
  if (existing) return existing
  const pending = createRealtimeNodeBus(authority, options)
  buses().set(authority, pending)
  // A failed connection is tried again by the next room that opens.
  pending.catch(() => {
    if (buses().get(authority) === pending) buses().delete(authority)
  })
  return pending
}

/**
 * Prints the room authority that this server uses. The generated Nitro plugin calls it when the server starts.
 * `database` is true when the build found the Default Database on Postgres.
 */
export function logRealtimeNodeAuthority(authority: RealtimeNodeAuthority = "auto", options: { database?: boolean } = {}): void {
  try {
    console.info(describeChoice(resolveRealtimeNodeAuthority(authority, options)))
  }
  catch (error) {
    console.error(error)
  }
}

/** Removes this instance's presence from the other instances and closes every bus. Nitro calls it when the server closes. */
export async function closeRealtimeBuses(): Promise<void> {
  const pending = [...buses().values()]
  buses().clear()
  await Promise.allSettled(pending.map(async (bus) => {
    await (await bus.catch(() => undefined))?.close()
  }))
}

function createBusBase() {
  const hooks: Array<() => Promise<void>> = []
  let closing: Promise<void> | undefined
  return {
    instance: crypto.randomUUID(),
    onClose(hook: () => Promise<void>) {
      hooks.push(hook)
    },
    /** Runs the close hooks once, then `end`. */
    close(end: () => Promise<void>): Promise<void> {
      closing ??= (async () => {
        await Promise.allSettled(hooks.map(hook => hook()))
        await end()
      })()
      return closing
    },
  }
}

type Listener = (message: RealtimeBusMessage) => void | Promise<void>

/**
 * Runs the listeners on each message in arrival order, also when one message needs an async step to read. `start`
 * subscribes once, for the first listener.
 */
function createDelivery(instance: string, read: (raw: string | Uint8Array) => Promise<Uint8Array | undefined>, start: (resubscribed: () => void) => Promise<void>) {
  let queue = Promise.resolve()
  const listeners = new Set<Listener>()
  const resubscribers = new Set<() => void>()
  let started: Promise<void> | undefined
  return {
    async subscribe(listener: Listener, resubscribed?: () => void) {
      listeners.add(listener)
      if (resubscribed) resubscribers.add(resubscribed)
      started ??= start(() => {
        for (const hook of resubscribers) hook()
      })
      await started
    },
    push(raw: string | Uint8Array) {
      queue = queue.then(async () => {
        const bytes = await read(raw)
        const message = bytes && decodeRealtimeBusMessage(bytes)
        if (!message || message.instance === instance) return
        for (const listener of listeners) await listener(message)
      }).catch((error: unknown) => {
        console.error("[vitehub] Realtime could not apply a message from another instance.", error)
      })
    },
  }
}

/** Sends messages one at a time, so that the other instances receive them in the order this instance sent them. */
function createSendQueue() {
  let queue = Promise.resolve()
  return <T>(send: () => Promise<T>): Promise<T> => {
    const sent = queue.then(send)
    queue = sent.then(() => {}, () => {})
    return sent
  }
}

/** Runs at most `limit` tasks at a time. */
function createLimit(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try {
      return await task()
    }
    finally {
      active--
      waiting.shift()?.()
    }
  }
}

const postgresChannel = "vitehub_realtime"
/** `NOTIFY` payloads stop at 8000 bytes. A larger message goes to a table, and the notification carries its id. */
const maxNotifyPayload = 7_900
/** Large messages stay this long for instances that read them late. */
const postgresMessageRetentionSeconds = 300
/** Pool size. A held room lock keeps one connection; the others serve reads, writes, and notifications meanwhile. */
const postgresConnections = 6
const postgresLockedSaves = 3
/** A stable number for `pg_advisory_xact_lock()` while the tables are created: "vhrt" in ASCII. */
const postgresSetupLock = 0x76687274

/** The part of postgres.js that the bus uses. */
interface PostgresClient {
  <T extends readonly object[] = Array<Record<string, unknown>>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T & { count: number }>
  begin<T>(task: (transaction: PostgresClient) => Promise<T>): Promise<T>
  listen(channel: string, onnotify: (payload: string) => void, onlisten?: () => void): Promise<{ unlisten(): Promise<void> }>
  end(options?: { timeout?: number }): Promise<void>
}

function isPostgresClient(value: unknown): value is PostgresClient {
  return typeof value === "function" && ["begin", "end", "listen"].every(name => typeof Reflect.get(value, name) === "function")
}

function bytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined
}

function toRecord(row: Record<string, unknown> | undefined): RealtimeRoomRecord | undefined {
  const state = bytes(row?.state)
  if (!row || typeof row.epoch !== "string" || !state) return undefined
  return { epoch: row.epoch, digest: typeof row.digest === "string" ? row.digest : null, state }
}

/**
 * Shares rooms through Postgres: `LISTEN`/`NOTIFY` carries room traffic, `vitehub_realtime_rooms` holds the shared
 * room records, and a transaction-scoped advisory lock orders saves. Creates its two tables when it connects. With
 * `{ client }`, the bus borrows the postgres.js client of a Database: it stops listening on close, and leaves the client
 * open.
 */
export async function createPostgresRealtimeBus(connection: { client: unknown } | { url: string }): Promise<RealtimeBus> {
  let sql: PostgresClient
  const owned = "url" in connection
  if ("url" in connection) {
    const { default: postgres } = await import("postgres")
    // SAFETY: postgres.js returns a tagged-template client with these methods; the interface names the part used here.
    sql = postgres(connection.url, { max: postgresConnections, onnotice: () => {} }) as unknown as PostgresClient
  }
  else if (isPostgresClient(connection.client)) sql = connection.client
  else throw realtimeErrorDiagnostics.REALTIME_MISSING_BUS_CONNECTION({ authority: "postgres" })
  const end = async () => {
    if (owned) await sql.end({ timeout: 5 })
  }
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(${postgresSetupLock})`
      await transaction`create table if not exists vitehub_realtime_rooms (room_key text primary key, epoch text not null, digest text, state bytea not null, updated_at timestamptz not null default now())`
      await transaction`create table if not exists vitehub_realtime_messages (id bigserial primary key, payload bytea not null, created_at timestamptz not null default now())`
    })
  }
  catch (error) {
    if (owned) await sql.end({ timeout: 1 }).catch(() => {})
    throw error
  }
  const base = createBusBase()
  let published = 0
  let listening: { unlisten(): Promise<void> } | undefined
  const send = createSendQueue()
  const locked = createLimit(postgresLockedSaves)
  const delivery = createDelivery(base.instance, async (raw) => {
    if (typeof raw !== "string") return
    if (raw.startsWith("m")) return Uint8Array.from(Buffer.from(raw.slice(1), "base64"))
    if (!raw.startsWith("r")) return
    const [row] = await sql`select payload from vitehub_realtime_messages where id = ${raw.slice(1)}`
    return bytes(row?.payload)
  }, async (resubscribed) => {
    let started = false
    listening = await sql.listen(postgresChannel, payload => delivery.push(payload), () => {
      if (started) resubscribed()
      started = true
    })
  })

  return {
    authority: "postgres",
    instance: base.instance,
    onClose: base.onClose,
    publish: message => send(async () => {
      const encoded = encodeRealtimeBusMessage({ ...message, instance: base.instance })
      const inline = `m${Buffer.from(encoded).toString("base64")}`
      if (inline.length <= maxNotifyPayload) {
        await sql`select pg_notify(${postgresChannel}, ${inline})`
        return
      }
      const [row] = await sql`insert into vitehub_realtime_messages (payload) values (${Buffer.from(encoded)}) returning id`
      await sql`select pg_notify(${postgresChannel}, ${`r${String(row?.id)}`})`
      if (++published % 100 === 1) {
        await sql`delete from vitehub_realtime_messages where created_at < now() - make_interval(secs => ${postgresMessageRetentionSeconds})`
      }
    }),
    subscribe: (listener, resubscribed) => delivery.subscribe(listener, resubscribed),
    async readRoom(room) {
      const [row] = await sql`select epoch, digest, state from vitehub_realtime_rooms where room_key = ${room}`
      return toRecord(row)
    },
    async writeRoom(room, record, ifEpoch) {
      const state = Buffer.from(record.state)
      const rows = ifEpoch === null
        ? await sql`insert into vitehub_realtime_rooms (room_key, epoch, digest, state) values (${room}, ${record.epoch}, ${record.digest}, ${state}) on conflict (room_key) do nothing returning room_key`
        : await sql`update vitehub_realtime_rooms set epoch = ${record.epoch}, digest = ${record.digest}, state = ${state}, updated_at = now() where room_key = ${room} and epoch = ${ifEpoch} returning room_key`
      return rows.length === 1
    },
    // A transaction-scoped lock ends with the transaction, and with the connection when the instance stops.
    withRoomLock: (room, task) => locked(() => sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`vitehub_realtime:${room}`}, 0))`
      return await task()
    })),
    close: () => base.close(async () => {
      await listening?.unlisten().catch(() => {})
      await end()
    }),
  }
}

const redisChannel = "vitehub:realtime"
const redisRoomPrefix = "vitehub:realtime:room:"
const redisLockPrefix = "vitehub:realtime:lock:"
/** A lock whose holder stopped expires after this time. */
const redisLockMs = 30_000

/** Writes the record when the stored epoch is ARGV[1], or when there is no record and ARGV[1] is empty. */
const redisWriteRoomScript = `
local current = redis.call('HGET', KEYS[1], 'epoch')
if (ARGV[1] == '' and current == false) or (current ~= false and current == ARGV[1]) then
  redis.call('HSET', KEYS[1], 'epoch', ARGV[2], 'digest', ARGV[3], 'hasDigest', ARGV[4], 'state', ARGV[5])
  return 1
end
return 0
`

const redisReleaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

/**
 * Shares rooms through Redis: pub/sub carries room traffic, one hash per room holds the shared room record, and a
 * `SET NX PX` lock orders saves.
 */
export async function createRedisRealtimeBus(url: string): Promise<RealtimeBus> {
  const { Redis } = await import("ioredis")
  const client = new Redis(url, { lazyConnect: true })
  const subscriber = client.duplicate()
  try {
    await Promise.all([client.connect(), subscriber.connect()])
  }
  catch (error) {
    client.disconnect()
    subscriber.disconnect()
    throw error
  }
  const base = createBusBase()
  const send = createSendQueue()
  const delivery = createDelivery(base.instance, async raw => typeof raw === "string" ? undefined : raw, async (resubscribed) => {
    subscriber.on("messageBuffer", (_channel: Buffer, message: Buffer) => delivery.push(Uint8Array.from(message)))
    await subscriber.subscribe(redisChannel)
    // ioredis subscribes again after a reconnect. Messages sent while it was down are lost.
    subscriber.on("ready", resubscribed)
  })

  return {
    authority: "redis",
    instance: base.instance,
    onClose: base.onClose,
    publish: message => send(async () => {
      await client.publish(redisChannel, Buffer.from(encodeRealtimeBusMessage({ ...message, instance: base.instance })))
    }),
    subscribe: (listener, resubscribed) => delivery.subscribe(listener, resubscribed),
    async readRoom(room) {
      const fields = await client.hgetallBuffer(`${redisRoomPrefix}${room}`)
      if (!fields.epoch || !fields.state) return undefined
      return {
        epoch: fields.epoch.toString(),
        digest: fields.hasDigest?.toString() === "1" ? fields.digest?.toString() ?? null : null,
        state: Uint8Array.from(fields.state),
      }
    },
    async writeRoom(room, record, ifEpoch) {
      const written = await client.eval(
        redisWriteRoomScript,
        1,
        `${redisRoomPrefix}${room}`,
        ifEpoch ?? "",
        record.epoch,
        record.digest ?? "",
        record.digest === null ? "0" : "1",
        Buffer.from(record.state),
      )
      return written === 1
    },
    async withRoomLock(room, task) {
      const key = `${redisLockPrefix}${room}`
      const token = crypto.randomUUID()
      const deadline = Date.now() + redisLockMs
      while (await client.set(key, token, "PX", redisLockMs, "NX") !== "OK") {
        if (Date.now() > deadline) throw realtimeErrorDiagnostics.REALTIME_ROOM_LOCK_TIMEOUT()
        await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 50))
      }
      try {
        return await task()
      }
      finally {
        await client.eval(redisReleaseLockScript, 1, key, token).catch(() => {})
      }
    },
    close: () => base.close(async () => {
      await Promise.allSettled([client.quit(), subscriber.quit()])
    }),
  }
}
