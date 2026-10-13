import { fileURLToPath } from "node:url"

// A `console.authorize` file for `exposure: "host-managed"` build tests. It allows every request.
export default function authorizeConsole(): boolean {
  return true
}

/** Absolute path of this file, for `console: { exposure: "host-managed", authorize }`. */
export const hostManagedAuthorize: string = fileURLToPath(import.meta.url)
