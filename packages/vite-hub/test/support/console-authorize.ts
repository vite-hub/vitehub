import { fileURLToPath } from "node:url"

// A `console.authorize` file for build tests. It allows every request.
export default function authorizeConsole(): boolean {
  return true
}

/** Absolute path of this file, for `console: { auth: false, authorize }` in development tests. */
export const hostManagedAuthorize: string = fileURLToPath(import.meta.url)

/**
 * Console options for production build tests. A production build refuses `auth: false`, so the app takes only signed
 * calls, and `authorize` allows every request.
 */
export const productionConsole: { authorize: string } = {
  authorize: hostManagedAuthorize,
}
