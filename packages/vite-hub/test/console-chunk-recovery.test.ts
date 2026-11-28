import { describe, expect, it, vi } from "vitest"

import { browserConsoleChunkHost, consoleChunkFailedTitle, consoleChunkOfflineTitle, createConsoleChunkRecovery, forgetConsoleChunkReload, isConsoleChunkError } from "../src/console/runtime/client/chunk-recovery"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

function host(online: boolean) {
  const listeners: (() => void)[] = []
  const state = {
    online,
    load: vi.fn<(path: string) => void>(),
    open: vi.fn<(path: string) => void>(),
    notify: vi.fn<(title: string) => void>(),
    storage: memoryStorage(),
    backOnline: () => {
      state.online = true
      for (const listener of listeners.splice(0)) listener()
    },
  }
  const recover = createConsoleChunkRecovery({
    online: () => state.online,
    onceOnline: listener => listeners.push(listener),
    load: state.load,
    open: state.open,
    notify: state.notify,
    storage: state.storage,
  })
  return { state, recover, listeners }
}

describe("Console page code recovery", () => {
  it("knows the errors of a page whose code did not load in Chrome, Firefox, and Safari, and of Vite CSS", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://console.example.com/assets/chunks/console-kv-abc.js",
      "error loading dynamically imported module: https://console.example.com/assets/chunks/console-kv-abc.js",
      "Importing a module script failed.",
      "Unable to preload CSS for https://console.example.com/assets/console-kv-abc.css",
    ]) expect(isConsoleChunkError(new TypeError(message)), message).toBe(true)
    expect(isConsoleChunkError(new Error("The server did not answer."))).toBe(false)
    expect(isConsoleChunkError("Failed to fetch dynamically imported module")).toBe(false)
  })

  it("says that the browser is offline, then opens the last page asked for when the browser is back online", () => {
    const { state, recover, listeners } = host(false)
    recover("/kv")
    recover("/schedules")
    expect(state.notify).toHaveBeenCalledTimes(2)
    expect(state.notify).toHaveBeenLastCalledWith(consoleChunkOfflineTitle)
    expect(listeners).toHaveLength(1)
    expect(state.open).not.toHaveBeenCalled()
    state.backOnline()
    expect(state.open).toHaveBeenCalledExactlyOnceWith("/schedules")
    expect(state.load).not.toHaveBeenCalled()
  })

  it("calls the retry of a lazy page instead of opening its path when the browser is back online", () => {
    const { state, recover } = host(false)
    const retry = vi.fn()
    recover("/team", retry)
    state.backOnline()
    expect(retry).toHaveBeenCalledOnce()
    expect(state.open).not.toHaveBeenCalled()
  })

  it("loads the page from the server once after a deploy renamed its code, and says so when that did not help", () => {
    const { state, recover } = host(true)
    recover("/kv")
    expect(state.load).toHaveBeenCalledExactlyOnceWith("/kv")
    recover("/kv")
    expect(state.load).toHaveBeenCalledOnce()
    expect(state.notify).toHaveBeenCalledExactlyOnceWith(consoleChunkFailedTitle)
    expect(forgetConsoleChunkReload(state.storage)).toBe(true)
    recover("/kv")
    expect(state.load).toHaveBeenCalledTimes(2)
  })

  it("does not load the page again and again when this browser keeps no session storage", () => {
    const { state } = host(true)
    const recover = createConsoleChunkRecovery({ ...state, onceOnline: () => {}, online: () => true, storage: undefined })
    recover("/kv")
    expect(state.load).not.toHaveBeenCalled()
    expect(state.notify).toHaveBeenCalledExactlyOnceWith(consoleChunkFailedTitle)
  })

  it("reads the browser window it is given, and loads the URL of a path", () => {
    const listeners: (() => void)[] = []
    const browser = {
      navigator: { onLine: false },
      location: { assign: vi.fn<(url: string) => void>() },
      sessionStorage: memoryStorage(),
      addEventListener: (_type: "online", listener: () => void) => void listeners.push(listener),
    }
    const open = vi.fn<(path: string) => void>()
    const pageHost = browserConsoleChunkHost(browser, open, path => `/console${path}`)
    expect(pageHost.online()).toBe(false)
    pageHost.onceOnline(() => pageHost.open("/kv"))
    for (const listener of listeners) listener()
    expect(open).toHaveBeenCalledExactlyOnceWith("/kv")
    pageHost.load("/kv")
    expect(browser.location.assign).toHaveBeenCalledExactlyOnceWith("/console/kv")
    expect(pageHost.storage).toBe(browser.sessionStorage)
  })

  it("keeps no session storage when the browser blocks it", () => {
    const browser = {
      navigator: { onLine: true },
      location: { assign: () => {} },
      get sessionStorage(): never {
        throw new DOMException("The operation is insecure.", "SecurityError")
      },
      addEventListener: () => {},
    }
    expect(browserConsoleChunkHost(browser, () => {}).storage).toBeUndefined()
  })
})
