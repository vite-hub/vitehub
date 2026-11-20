/** A page event that a client store reacts to. */
export type BrowserEvent = "online" | "offline" | "visible" | "hidden"

/** What a client store needs from the browser: page events, one sender across tabs, and messages between tabs. Tests pass a fake one. */
export interface BrowserEnvironment<Message> {
  listen: (listener: (event: BrowserEvent) => void) => () => void
  isVisible: () => boolean
  isOnline: () => boolean
  /** Runs `task` while this tab holds the lock `name`, so one tab at a time sends. */
  lock: <T>(name: string, task: () => Promise<T>) => Promise<T>
  /**
   * Runs `task` once this tab is the leader for `name`, so one tab of the browser does it at a time. The tab stays the
   * leader until `task` ends. The returned function gives up: it aborts the signal of `task`, or stops waiting.
   */
  lead: (name: string, task: (signal: AbortSignal) => Promise<void>) => () => void
  post: (message: Message) => void
  receive: (listener: (message: Message) => void) => () => void
  /** Runs `task` after `ms`. Returns a function that cancels it. */
  schedule: (task: () => void, ms: number) => () => void
  random: () => number
}

export interface BrowserEnvironmentOptions<Message> {
  /** The BroadcastChannel name that the tabs share, such as `vitehub-sync`. */
  channel: string
  /** Keeps only the messages of this store. Another version of the page can post other shapes. */
  isMessage: (value: unknown) => value is Message
}

/** The real browser: window events, Web Locks, and a BroadcastChannel, each only when the browser has it. */
export function createBrowserEnvironment<Message>(options: BrowserEnvironmentOptions<Message>): BrowserEnvironment<Message> {
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
      else postOnce(options.channel, message)
    },
    receive(listener) {
      if (typeof BroadcastChannel !== "function") return () => undefined
      const own = new BroadcastChannel(options.channel)
      channel = own
      own.onmessage = (event: MessageEvent<unknown>) => {
        if (options.isMessage(event.data)) listener(event.data)
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

/** Posts one message on a channel of its own, so every open channel of that name gets it. */
export function postOnce(channel: string, message: unknown): void {
  if (typeof BroadcastChannel !== "function") return
  const own = new BroadcastChannel(channel)
  own.postMessage(message)
  own.close()
}

/**
 * A version 4 UUID. `crypto.randomUUID()` exists only on HTTPS and localhost, and an app on a LAN address in development
 * has neither, so this falls back to `crypto.getRandomValues()`.
 */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0F) | 0x40
  bytes[8] = (bytes[8]! & 0x3F) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The wait before try `attempt + 1`: 1 s doubling to 30 s, with jitter over its upper half. `random` is in [0, 1). */
export function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(30_000, 1000 * 2 ** attempt)
  return ceiling / 2 + random * ceiling / 2
}
