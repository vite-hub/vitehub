/** A page event that the store reacts to. */
type SyncEvent = "online" | "offline" | "visible" | "hidden"

/**
 * A message between tabs. `change` tells that the stored copy of a Sync route changed. `queued` tells that it has writes
 * that the sender does not send, since its store stopped, so a store that gets the message sends them.
 */
type SyncMessage = { type: "change", id: string, queued?: true } | { type: "clear" }

/** What the store needs from the browser. Tests pass a fake one. */
interface SyncEnvironment {
  listen: (listener: (event: SyncEvent) => void) => () => void
  isVisible: () => boolean
  isOnline: () => boolean
  /** Runs `task` while this tab holds the lock `name`, so one tab at a time sends. */
  lock: <T>(name: string, task: () => Promise<T>) => Promise<T>
  /**
   * Runs `task` once this tab is the leader for `name`, so one tab of the browser does it at a time. The tab stays the
   * leader until `task` ends. The returned function gives up: it aborts the signal of `task`, or stops waiting.
   */
  lead: (name: string, task: (signal: AbortSignal) => Promise<void>) => () => void
  post: (message: SyncMessage) => void
  receive: (listener: (message: SyncMessage) => void) => () => void
  /** Runs `task` after `ms`. Returns a function that cancels it. */
  schedule: (task: () => void, ms: number) => () => void
  random: () => number
}

const channelName = "vitehub-sync"

function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== "object") return false
  const type: unknown = Reflect.get(value, "type")
  return type === "clear" || (type === "change" && typeof Reflect.get(value, "id") === "string")
}

/** The real browser: window events, Web Locks, and a BroadcastChannel, each only when the browser has it. */
function createBrowserEnvironment(): SyncEnvironment {
  let channel: BroadcastChannel | undefined
  return {
    listen(listener) {
      const online = () => listener("online")
      const offline = () => listener("offline")
      const visibility = () => listener(document.visibilityState === "hidden" ? "hidden" : "visible")
      window.addEventListener("online", online)
      window.addEventListener("offline", offline)
      document.addEventListener("visibilitychange", visibility)
      return () => {
        window.removeEventListener("online", online)
        window.removeEventListener("offline", offline)
        document.removeEventListener("visibilitychange", visibility)
      }
    },
    isVisible: () => document.visibilityState !== "hidden",
    isOnline: () => navigator.onLine !== false,
    lock(name, task) {
      const locks = navigator.locks
      return locks ? locks.request(name, task) : task()
    },
    lead(name, task) {
      const controller = new AbortController()
      const run = () => controller.signal.aborted ? Promise.resolve() : task(controller.signal)
      // Without Web Locks, as on a LAN address over HTTP, each tab leads.
      const locks = navigator.locks
      if (locks) locks.request(name, { signal: controller.signal }, run).catch(() => undefined)
      else void run()
      return () => controller.abort()
    },
    post(message) {
      if (channel) channel.postMessage(message)
      // A stopped store still tells the other stores of the page and the other tabs about the writes that it stored.
      else postOnce(message)
    },
    receive(listener) {
      if (typeof BroadcastChannel !== "function") return () => undefined
      const own = new BroadcastChannel(channelName)
      channel = own
      own.onmessage = (event: MessageEvent<unknown>) => {
        if (isSyncMessage(event.data)) listener(event.data)
      }
      return () => {
        own.close()
        if (channel === own) channel = undefined
      }
    },
    schedule(task, ms) {
      const timer = setTimeout(task, ms)
      return () => clearTimeout(timer)
    },
    random: Math.random,
  }
}

/** Posts one message on a channel of its own, so every open channel gets it. */
function postOnce(message: SyncMessage): void {
  if (typeof BroadcastChannel !== "function") return
  const channel = new BroadcastChannel(channelName)
  channel.postMessage(message)
  channel.close()
}

/** Tells the other tabs that every store was cleared. */
function postClear(): void {
  postOnce({ type: "clear" })
}

export { createBrowserEnvironment, postClear }
export type { SyncEnvironment, SyncEvent, SyncMessage }
