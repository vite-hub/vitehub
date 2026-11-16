import { defineErrors } from "@vite-hub/runtime"

import type { ResultError } from "@vite-hub/runtime"

// Keep published codes stable. Each code has a page at https://vitehub.dev/docs/device/diagnostics/<code>.
export const deviceErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/device/diagnostics",
  codes: {
    // Thrown by `openDevice()`.
    DEVICE_ALREADY_OPEN: {
      why: ({ version, open }: { version: string, open: string }) => `\`openDevice()\` was called with the version ${JSON.stringify(version)}, and the device is already open with the version ${JSON.stringify(open)}.`,
      fix: "Call `openDevice()` once, before `app.mount()`, with one `version` for the build.",
    },
    // The `error` of a `useStoredFetch()` read whose answer is not 2xx.
    DEVICE_FETCH_FAILED: {
      why: ({ url, status }: { url: string, status: number }) => `GET ${url} answered ${status}. \`useStoredFetch()\` keeps what the read shows, and the device does not store the answer.`,
      fix: "Check that the route answers 2xx with JSON for this request. For a 401, sign the person in again. For another error, read the server log of the route.",
    },
    // Thrown by `setDeviceAccount()`.
    DEVICE_INVALID_ACCOUNT: {
      why: ({ account }: { account: string }) => `\`setDeviceAccount()\` got ${account}. It takes the id of the signed-in account, or \`null\` after a sign-out.`,
      fix: "Pass the user id from your session as a string, such as `setDeviceAccount(session.user.id)`, or `null` when no one is signed in.",
    },
    // Thrown by `useStoredData()`.
    DEVICE_INVALID_KEY: {
      why: ({ key }: { key: string }) => `\`useStoredData()\` got the key ${key}. A key must be a string that is not empty.`,
      fix: "Give each read a key that names its data, such as `'projects'` or `` `project:${id}` ``.",
    },
    // Thrown by `useStoredData()`.
    DEVICE_INVALID_MAX_AGE: {
      why: ({ maxAge }: { maxAge: string }) => `\`maxAge\` is ${maxAge}. It must be a number of milliseconds that is 0 or more.`,
      fix: "Set `maxAge` in milliseconds, such as `24 * 60 * 60 * 1000` for one day, or remove it to keep the default of 7 days.",
    },
    // Printed once when a read stores a value and the app did not call `openDevice()`.
    DEVICE_NOT_OPEN: {
      why: "`useStoredData()` keeps the answer in memory only, because the app did not call `openDevice()`. A reload shows the default, not the stored copy.",
      fix: "Call `await openDevice()` before `app.mount()`. In an app that the server renders, call `openDevice()` after the app mounts.",
    },
    // `setDeviceAccount()` and `clearDevice()` return it. A stored write prints it once.
    DEVICE_STORAGE_FAILED: {
      why: ({ action }: { action: string }) => `IndexedDB failed to ${action}. The stored copies on the device can be out of date.`,
      fix: "Call the function again. If it fails again, ask the user to clear the site data in the browser settings. The browser console has the IndexedDB error as the cause.",
    },
    // Printed once for each key.
    DEVICE_VALUE_NOT_JSON: {
      why: ({ key }: { key: string }) => `The loader of \`${key}\` returned a value that JSON cannot store, so the device does not keep it.`,
      fix: "Return plain data from the loader: objects, arrays, strings, numbers, booleans, and null. Turn a `Date` into a string and a `Map` into an object.",
    },
    // Printed once for each key.
    DEVICE_VALUE_TOO_LARGE: {
      why: ({ key, bytes, limit }: { key: string, bytes: number, limit: number }) => `The answer of \`${key}\` has ${bytes} bytes as JSON. The device keeps at most ${limit} bytes, so it does not keep this answer.`,
      fix: "Store less: load one page of a list, or only the fields that the first screen shows.",
    },
  },
})

/** Prints a diagnostic that does not stop the read, with the lower-level error when it has one. */
export function warn(error: ResultError): void {
  const message = `[vitehub] ${error.code}: ${error.why} ${error.fix ?? ""}`.trim()
  if (error.cause === undefined) console.warn(message)
  else console.warn(message, error.cause)
}
