import { useStoredData } from "@vite-hub/device/vue"
import { effectScope, watch } from "vue"

import type { StoredDataContext, UseStoredDataOptions, UseStoredDataReturn } from "@vite-hub/device/vue"

/**
 * The version of the answers that the Console keeps on the device. Change it when the shape of a stored answer changes,
 * so the next visit does not show an answer of the old shape.
 */
export const consoleDeviceVersion = "console-1"

/** The answer of `GET /api/account`. */
export const consoleAccountKey = "console:account"

/** The answer of `project.get` of a project, with its navigation. */
export const consoleProjectKey = (id: string): string => `console:project:${id}`

/** The check of a linked app on the Console server, which the team sidebar shows. */
export const consoleAppCheckKey = (id: string): string => `console:app-check:${id}`

/** A stored read of the boot, which runs outside a component, until `stop()`. */
export interface ConsoleStoredRead<T> {
  /** The answer that this device kept from an earlier visit of the same account, or `undefined`. */
  stored: T | undefined
  /** The read, which follows the device: it starts over when the page names its account or the device resets. */
  read: UseStoredDataReturn<T, undefined>
  /**
   * The next answer that the read accepts. While the read starts over, such as when the page names its account, this
   * waits for the answer of the new call. It rejects with what the loader threw.
   */
  answer: () => Promise<T>
  /** Ends the read and aborts its loader call. */
  stop: () => void
}

/**
 * Read `key` with `useStoredData()` outside a component, for as long as the boot needs it. Call `openDevice()` before,
 * or `stored` is always `undefined`.
 */
export function readStored<T>(key: string, loader: (context: StoredDataContext) => Promise<T>, options: UseStoredDataOptions<T, undefined> = {}): ConsoleStoredRead<T> {
  const scope = effectScope(true)
  // SAFETY: `run()` returns the value of its function while the scope is active, and the scope is new.
  const read = scope.run(() => useStoredData<T>(key, loader, options))!
  const stored = read.storedAt.value ? read.data.value : undefined
  // Without a document, as on the server, the read calls no loader. The boot asks on its own then.
  const direct = read.status.value === "idle" ? loader({ signal: new AbortController().signal }) : undefined
  const answer = (): Promise<T> => direct ?? new Promise<T>((resolve, reject) => {
    const stop = scope.run(() => watch(read.status, (status) => {
      if (status === "pending" || status === "idle") return
      // `watch` runs this before it returns `stop` when the read already answered.
      queueMicrotask(() => stop?.())
      // SAFETY: a read that answered holds the answer of its loader, which is a `T`.
      if (status === "success") resolve(read.data.value as T)
      else reject(read.error.value)
    }, { immediate: true }))
  })
  return { stored, read, answer, stop: () => scope.stop() }
}
