import { useConsoleToast } from "./toast"

const chunkFailure = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/u

/** The error of a page whose code did not load: Chrome, Firefox, and Safari word it differently, and Vite adds CSS. */
export function isConsoleChunkError(error: unknown): boolean {
  return error instanceof Error && chunkFailure.test(error.message)
}

export interface ConsoleChunkRecoveryHost {
  online: () => boolean
  /** Calls `listener` once, the next time the browser is back online. */
  onceOnline: (listener: () => void) => void
  /** Loads `path` from the server, as a link outside the Console does. */
  load: (path: string) => void
  /** Opens `path` in place again. */
  open: (path: string) => void
  notify: (title: string) => void
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined
}

export const consoleChunkReloadKey = "vitehub-console:chunk-reload"
export const consoleChunkOfflineTitle = "This browser is offline, so the page did not open. It opens when the network is back."
export const consoleChunkFailedTitle = "The page did not load. Reload the Console."

/**
 * Opens `path` again after its code did not load. Offline, it says so and calls `again` when the browser is back
 * online; `again` opens `path` in place by default. Online, the Console was deployed again and the code of this page has
 * a new name, so the browser loads `path` from the server. It does that once for a path, so a broken deploy does not
 * load the page again and again.
 */
export function createConsoleChunkRecovery(host: ConsoleChunkRecoveryHost): (path: string, again?: () => void) => void {
  let waiting: (() => void) | undefined
  return (path, again = () => host.open(path)) => {
    if (!host.online()) {
      host.notify(consoleChunkOfflineTitle)
      if (!waiting) {
        host.onceOnline(() => {
          const next = waiting
          waiting = undefined
          next?.()
        })
      }
      waiting = again
      return
    }
    if (read(host.storage) === path || !remember(host.storage, path)) {
      host.notify(consoleChunkFailedTitle)
      return
    }
    host.load(path)
  }
}

/** The host of a Console page in a browser. `open` opens a path in place, and `href` gives the URL of a path. */
export function browserConsoleChunkHost(open: (path: string) => void, href: (path: string) => string = path => path): ConsoleChunkRecoveryHost {
  return {
    online: () => navigator.onLine,
    onceOnline: listener => window.addEventListener("online", listener, { once: true }),
    load: path => window.location.assign(href(path)),
    open,
    notify: title => useConsoleToast().error(title),
    storage: sessionStorageOrUndefined(),
  }
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage
  }
  catch {
    return undefined
  }
}

/** The page opened, so a later failure of its code can load the page again. Returns `false` when storage is off. */
export function forgetConsoleChunkReload(storage: ConsoleChunkRecoveryHost["storage"]): boolean {
  try {
    storage?.removeItem(consoleChunkReloadKey)
    return true
  }
  catch {
    return false
  }
}

function read(storage: ConsoleChunkRecoveryHost["storage"]): string | null {
  try {
    return storage?.getItem(consoleChunkReloadKey) ?? null
  }
  catch {
    return null
  }
}

function remember(storage: ConsoleChunkRecoveryHost["storage"], path: string): boolean {
  if (!storage) return false
  try {
    storage.setItem(consoleChunkReloadKey, path)
    return true
  }
  catch {
    return false
  }
}
