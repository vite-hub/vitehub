import type { SyncLiveEvent } from "./protocol.ts"

/**
 * The listeners of open live streams in this process, by Database and Sync name. The key is the `db` of the
 * `SyncServices`, the Database or the function that returns it, because it stays the same for every request.
 */
const listeners = new WeakMap<object, Map<string, Set<() => void>>>()

/** Wakes the live streams of a Sync name on this Database in this process, after a write committed. */
export function wakeLiveStreams(key: object, name: string): void {
  for (const listener of listeners.get(key)?.get(name) ?? []) listener()
}

function listen(key: object, name: string, listener: () => void): () => void {
  let names = listeners.get(key)
  if (!names) listeners.set(key, names = new Map())
  let set = names.get(name)
  if (!set) names.set(name, set = new Set())
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size) names.delete(name)
  }
}

const pingInterval = 15_000

/** What a live stream does. */
export interface LiveStream {
  /** The key of `wakeLiveStreams()`. */
  key: object
  name: string
  signal: AbortSignal
  /** Milliseconds between two checks of the change log. */
  interval: number
  /** Seconds until the stream ends. */
  seconds: number
  /**
   * One check. `first` is `true` for the check when the stream opens. Returns the event to send, if any, and whether to
   * check again at once, such as when a pull has `more`.
   */
  check: (first: boolean) => Promise<{ event?: SyncLiveEvent, again?: boolean }>
}

function format(event: SyncLiveEvent): string {
  const { type, ...data } = event
  const id = type === "pull" ? `id: ${event.pull.cursor}\n` : ""
  return `event: ${type}\n${id}data: ${JSON.stringify(data)}\n\n`
}

/**
 * A `text/event-stream` response that runs `check` when the stream opens, then every `interval`, and at once when a
 * write in this process wakes it. It sends `: ping` every 15 seconds, and ends after `seconds` or when the client
 * goes away.
 */
export function liveResponse(stream: LiveStream): Response {
  const encoder = new TextEncoder()
  let stop = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = Date.now() + stream.seconds * 1000
      let closed = false
      let woken = false
      let resume: (() => void) | undefined
      const wake = () => {
        woken = true
        resume?.()
      }
      const send = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        }
        catch {
          // The client went away. The loop ends at its next step.
          finish()
        }
      }
      const unlisten = listen(stream.key, stream.name, wake)
      // Node sends the status and the headers with the first chunk of the body. Without this comment, a stream with
      // nothing to send has no answer until the first ping, and the client waits 15 seconds to know that it is live.
      send(": open\n\n")
      const ping = setInterval(() => send(": ping\n\n"), pingInterval)
      function finish() {
        if (closed) return
        closed = true
        unlisten()
        clearInterval(ping)
        stream.signal.removeEventListener("abort", finish)
        resume?.()
        try {
          controller.close()
        }
        catch {
          // The stream is closed already.
        }
      }
      stop = finish
      stream.signal.addEventListener("abort", finish)
      if (stream.signal.aborted) finish()

      void (async () => {
        let first = true
        try {
          while (!closed) {
            woken = false
            const { event, again } = await stream.check(first)
            first = false
            if (event) send(format(event))
            if (again) continue
            const left = end - Date.now()
            if (left <= 0) break
            if (!woken && !closed) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(done, Math.min(stream.interval, left))
                function done() {
                  clearTimeout(timer)
                  resume = undefined
                  resolve()
                }
                resume = done
              })
            }
            if (Date.now() >= end) break
          }
        }
        catch (error) {
          // The client opens a new stream after a pause, so a failed check ends this one.
          console.error(`[vitehub] The live Sync stream of "${stream.name}" failed.`, error)
        }
        finish()
      })()
    },
    cancel() {
      stop()
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "private, no-store", "x-accel-buffering": "no" } })
}
