import { checkAccount, currentDevice } from "./device.ts"

import type { Result } from "@vite-hub/runtime"
import type { DeviceInspection, OpenDeviceOptions } from "./device.ts"

export type { DeviceInspection, OpenDeviceOptions } from "./device.ts"

/**
 * Reads the stored copies into memory, so the first render of `useStoredData()` shows them at once. Await it before
 * `app.mount()`. It never fails: without IndexedDB, or when IndexedDB takes more than 1 second, the page keeps its
 * copies in memory and `inspectDevice()` says `storage: "memory"`. On the server, it does nothing.
 *
 * ```ts
 * import { openDevice } from 'vite-hub/device'
 *
 * await openDevice({ version: '2' })
 * app.mount('#app')
 * ```
 */
export function openDevice(options?: OpenDeviceOptions): Promise<void> {
  return currentDevice()?.open(options) ?? Promise.resolve()
}

/**
 * Names the signed-in account, so its copies stay on the device across reloads. Call it each time the app learns who
 * is signed in. Another account, or `null` after a sign-out, deletes every copy in every tab. Until the page names an
 * account, answers stay in memory and nothing is written to the disk.
 */
export function setDeviceAccount(account: string | null): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
  checkAccount(account)
  return currentDevice()?.setAccount(account) ?? Promise.resolve([undefined, undefined])
}

/** Deletes every stored copy, in this tab and in every other tab of the app. The account stays. */
export function clearDevice(): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
  return currentDevice()?.clear() ?? Promise.resolve([undefined, undefined])
}

/** The account, the storage, and each stored copy of this tab, to debug stored reads in code or in the browser console. */
export function inspectDevice(): DeviceInspection {
  return currentDevice()?.inspect() ?? { account: null, persisted: false, storage: "memory", entries: [] }
}
