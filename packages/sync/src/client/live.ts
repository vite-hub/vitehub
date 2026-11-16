// The live stream of a tab: one connection for every store of the tab. It reads the Server-Sent Events body by hand, so
// the client needs no `EventSource`: that one cannot POST, cannot use the `fetch` option of the store, and reconnects
// on its own schedule. Only the `event` and `data` fields matter to Sync.
import { backoffDelay, isPull, readError, whereKey } from "./view.ts"

import type { SyncLivePull, SyncPullResponse, SyncValues } from "../protocol.ts"
import type { SyncEnvironment } from "./environment.ts"

/** One event of the stream. `type` is `message` when the server sent no `event` field. */
interface SyncStreamEvent {
  type: string
  data: string
}

/**
 * The events of `body`, in order. Comment lines, such as `: ping`, are skipped. Ends when the body ends, or when
 * `signal` aborts, also with a `fetch` that does not end the body on abort.
 */
async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SyncStreamEvent> {
  const reader = body.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener("abort", cancel)
  if (signal?.aborted) cancel()
  const decoder = new TextDecoder()
  let buffer = ""
  let type = ""
  let data: string[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const end = buffer.search(/[\r\n]/)
        // A `\r` at the end can be the first half of `\r\n`, so it waits for the next chunk.
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1))
        if (line === "") {
          if (data.length) yield { type: type || "message", data: data.join("\n") }
          type = ""
          data = []
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const text = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1))
        if (field === "event") type = text
        else if (field === "data") data.push(text)
      }
    }
  }
  finally {
    signal?.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => undefined)
  }
}

/** What a store holds when a live stream opens with it. */
interface SyncLiveHeld {
  cursor: number
  scope: string
  version: string
}

/** A store in the live stream of its tab. */
interface SyncLiveEntry {
  name: string
  /** The subset of the store. */
  where: SyncValues
  /** What the store holds now. A stream opens with it. `undefined` leaves the store out of that stream. */
  held: () => SyncLiveHeld | undefined
  /** `true` when a stream with the store opened. `false` when the stream ended, or the tab ended it to open another. */
  live: (open: boolean) => void
  /** A pull of the stream for the store, and the cursor that the pull starts from. */
  pull: (pull: SyncPullResponse, base: number) => void
  /** The stream stopped for the store, and the store left it: the stream `failed`, or the server `refused` the store. */
  stop: (end: "failed" | "refused") => void
}

/** The live stream of one tab. Every store of the tab that leads its live changes shares it. */
interface SyncLive {
  /** Adds a store to the stream. Returns the function that removes it. */
  join: (entry: SyncLiveEntry) => () => void
  /**
   * Ends the stream at once and opens it again, such as after the account of a store changed. With `failed`, such as
   * after pulls of another session, the next stream waits for the backoff.
   */
  reopen: (failed?: boolean) => void
}

/** Milliseconds that the stream waits after a store joins or leaves, so stores that open together reopen it once. */
const reopenDelay = 100

/** A stream that ends sooner than this counts as a failure, so a proxy that closes it at once gets backoff. */
const shortestStream = 1000

type StreamEnd = "ended" | "failed" | "refused" | "aborted"

/** A store in an open stream, with the cursor of its next pull. */
interface Streamed {
  entry: SyncLiveEntry
  base: number
}

/** The name and subset of a store, as one text. */
function storeKey(name: string, where: unknown): string {
  return `${name}?${whereKey(where && typeof where === "object" ? where : undefined)}`
}

/**
 * One live stream for the stores of a tab, at `url` (`<base>api/_vitehub/sync`). It opens when the first store joins,
 * opens again after a short pause when stores join or leave, and closes when the last one leaves. Each pull goes to
 * its store by name and subset. After a failure, the stores pull, and join again when the pull works; the stream then
 * waits for the backoff.
 */
function createSyncLive(options: { url: string, fetch: typeof fetch, environment: Pick<SyncEnvironment, "listen" | "schedule" | "random"> }): SyncLive {
  const { environment } = options
  const entries = new Set<SyncLiveEntry>()
  // Streams that failed or ended at once in a row. The next stream waits for the backoff of this count.
  let failures = 0
  // The open stream, and its stores.
  let current: { controller: AbortController, streamed: Map<string, Streamed> } | undefined
  let soon = false
  let cancelLater: (() => void) | undefined

  // The network or the page is back, so a stream may work again at once.
  environment.listen((event) => {
    if (event === "online" || event === "visible") failures = 0
  })

  /** Ends the open stream. Its stores are not live until a new stream opens. */
  function abortCurrent(): void {
    const ended = current
    current = undefined
    if (!ended) return
    ended.controller.abort()
    for (const { entry } of ended.streamed.values()) entry.live(false)
  }

  /** Opens the stream on the next microtask, with every store that joined until then. */
  function openSoon(): void {
    cancelLater?.()
    cancelLater = undefined
    if (soon) return
    soon = true
    queueMicrotask(() => {
      soon = false
      void connect()
    })
  }

  /** Opens the stream after `ms`, or after the backoff of the failures. A later call starts the wait again. */
  function openLater(ms: number): void {
    if (soon) return
    cancelLater?.()
    cancelLater = environment.schedule(() => {
      cancelLater = undefined
      void connect()
    }, failures ? backoffDelay(failures - 1, environment.random()) : ms)
  }

  async function connect(): Promise<void> {
    abortCurrent()
    const streamed = new Map<string, Streamed>()
    const pulls: SyncLivePull[] = []
    for (const entry of entries) {
      const held = entry.held()
      if (!held) continue
      streamed.set(storeKey(entry.name, entry.where), { entry, base: held.cursor })
      pulls.push({ name: entry.name, ...(whereKey(entry.where) ? { where: entry.where } : {}), ...held })
    }
    if (!pulls.length) return
    const own = new AbortController()
    current = { controller: own, streamed }
    const started = Date.now()
    const end = await read(own.signal, pulls, streamed)
    // A newer stream replaced this one, or every store left.
    if (end === "aborted" || own.signal.aborted) return
    current = undefined
    if (end === "ended") {
      for (const { entry } of streamed.values()) entry.live(false)
      failures = Date.now() - started >= shortestStream ? 0 : failures + 1
      if (!entries.size) return
      if (failures) openLater(0)
      else openSoon()
      return
    }
    failures++
    for (const { entry } of streamed.values()) {
      if (entries.delete(entry)) entry.stop(end)
    }
  }

  /** Opens one stream and gives its events to the stores, until it ends. */
  async function read(signal: AbortSignal, pulls: SyncLivePull[], streamed: Map<string, Streamed>): Promise<StreamEnd> {
    let response: Response
    try {
      response = await options.fetch(options.url, { method: "POST", headers: { "content-type": "application/json", "accept": "text/event-stream" }, body: JSON.stringify({ pulls }), cache: "no-store", signal })
    }
    catch {
      return signal.aborted ? "aborted" : "failed"
    }
    if (!response.ok) {
      const reason = readError(response.status, await response.json().catch(() => undefined))
      // A server without live streams.
      return reason.code === "SYNC_BAD_REQUEST" ? "refused" : "failed"
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined)
      return "refused"
    }
    try {
      for await (const event of readEvents(response.body, signal)) {
        if (signal.aborted) return "aborted"
        // The server refused the stores that it would, so the others are live.
        if (event.type === "open") {
          for (const { entry } of streamed.values()) {
            if (entries.has(entry)) entry.live(true)
          }
          continue
        }
        if (event.type !== "pull" && event.type !== "error") continue
        const data: unknown = JSON.parse(event.data)
        if (!data || typeof data !== "object") continue
        const name: unknown = Reflect.get(data, "name")
        const key = storeKey(String(name), Reflect.get(data, "where"))
        const found = streamed.get(key)
        // A store that left gets nothing more from this stream.
        if (!found || !entries.has(found.entry)) continue
        if (event.type === "error") {
          // The server refused this store alone, such as after a sign-out. The other stores stream on.
          const code: unknown = Reflect.get(Object(Reflect.get(data, "error")), "code")
          streamed.delete(key)
          entries.delete(found.entry)
          found.entry.stop(code === "SYNC_BAD_REQUEST" ? "refused" : "failed")
          continue
        }
        const next: unknown = Reflect.get(data, "pull")
        if (!isPull(next)) continue
        found.entry.pull(next, found.base)
        found.base = next.cursor
      }
    }
    catch {
      return signal.aborted ? "aborted" : "failed"
    }
    return signal.aborted ? "aborted" : "ended"
  }

  return {
    join(entry) {
      entries.add(entry)
      if (current || cancelLater || failures) openLater(reopenDelay)
      else openSoon()
      return () => {
        if (!entries.delete(entry)) return
        if (entries.size) {
          openLater(reopenDelay)
          return
        }
        cancelLater?.()
        cancelLater = undefined
        abortCurrent()
      }
    },
    reopen(failed = false) {
      if (failed) failures++
      abortCurrent()
      if (!entries.size) return
      if (failures) openLater(0)
      else openSoon()
    },
  }
}

export { createSyncLive, readEvents }
export type { SyncLive, SyncLiveEntry, SyncLiveHeld, SyncStreamEvent }
