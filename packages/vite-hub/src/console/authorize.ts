import type { ConsoleAuthorize } from "./auth-types.ts"

/** Define the function that every Console data route calls. Set its file path as `console.authorize`. */
export function defineConsoleAuthorize(authorize: ConsoleAuthorize): ConsoleAuthorize {
  // Accept callbacks created in another JavaScript realm, where `instanceof Function` fails.
  if (typeof authorize !== "function") throw new TypeError("[vitehub] defineConsoleAuthorize() requires a function.")
  return authorize
}
