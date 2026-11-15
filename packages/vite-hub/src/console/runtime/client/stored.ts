import { useStoredData } from "@vite-hub/device/vue"
import { effectScope } from "vue"

import type { StoredDataContext } from "@vite-hub/device/vue"

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

/** A stored read of the boot, which runs outside a component. */
export interface ConsoleStoredRead<T> {
  /** The answer that this device kept from an earlier visit of the same account, or `undefined`. */
  stored: T | undefined
  /** The answer of this visit. The device keeps it for the next visit. */
  answer: Promise<T>
}

/**
 * Read `key` with `useStoredData()` outside a component: the stored copy now, and the answer when the loader settles.
 * Call `openDevice()` before, or `stored` is always `undefined`.
 */
export function readStored<T>(key: string, loader: (context: StoredDataContext) => Promise<T>): ConsoleStoredRead<T> {
  const scope = effectScope(true)
  let answer: Promise<T> | undefined
  const read = scope.run(() => useStoredData<T>(key, context => (answer = loader(context))))
  // Without a document, as on the server, the read calls no loader. A read of this key that already runs shares its
  // call with this one. In both cases this read asks on its own.
  answer ??= loader({ signal: new AbortController().signal })
  const stored = read?.storedAt.value ? read.data.value : undefined
  // The device keeps the answer before this runs, so the read can go.
  answer.then(() => scope.stop(), () => scope.stop())
  return { stored, answer }
}
