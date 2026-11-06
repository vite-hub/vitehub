import { fileURLToPath } from "node:url"

// A `console.authorize` file for build tests. It allows every request.
export default function authorizeConsole(): boolean {
  return true
}

/** Absolute path of this file, for `console: { auth: false, authorize }` in development tests. */
export const hostManagedAuthorize: string = fileURLToPath(import.meta.url)

/**
 * Console options for production build tests. A production build refuses `auth: false`. Cloudflare Access needs no app
 * Auth and no files, and `authorize` allows every request. Add `embed: true` when a test needs the Console pages.
 */
export const productionConsole: { auth: { provider: "cloudflare-access" }, authorize: string } = {
  auth: { provider: "cloudflare-access" },
  authorize: hostManagedAuthorize,
}
