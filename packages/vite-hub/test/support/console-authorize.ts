import { fileURLToPath } from "node:url"

// A `console.authorize` file for build tests. It allows every request.
export default function authorizeConsole(): boolean {
  return true
}

/** Absolute path of this file, for `console: { auth: false, authorize }`. */
export const hostManagedAuthorize: string = fileURLToPath(import.meta.url)
