import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { AuthStatelessPreset } from "./presets.ts"

// These plugins keep one-time tokens in Better Auth's verification table, so they need a database.
const verificationPluginIds = new Set(["email-otp", "magic-link", "one-time-token"])

// The stateless preset owns these Better Auth options. A second value would silently change the session model.
const statelessOwnedOptions = [
  ["session", "expiresIn"],
  ["session", "cookieCache", "enabled"],
  ["session", "cookieCache", "maxAge"],
  ["session", "cookieCache", "refreshCache"],
  ["session", "cookieCache", "strategy"],
  ["account", "storeAccountCookie"],
  ["account", "storeStateStrategy"],
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function readStatelessPreset(value: unknown): AuthStatelessPreset {
  if (isPlainObject(value) && value.name === "stateless" && typeof value.maxAge === "number" && Number.isSafeInteger(value.maxAge) && value.maxAge > 0) {
    return { name: "stateless", maxAge: value.maxAge }
  }
  throw authErrorDiagnostics.AUTH_C0041({ message: "`defineAuth()` preset must be a preset such as `stateless()` from `@vite-hub/auth/presets`." })
}

function storedPluginId(plugin: unknown): string | undefined {
  if (!isPlainObject(plugin)) return
  const id = typeof plugin.id === "string" ? plugin.id : "unknown"
  if (isPlainObject(plugin.schema) && Object.keys(plugin.schema).length > 0) return id
  if (verificationPluginIds.has(id)) return id
}

/** Checks that the options can run with `stateless()` and returns the Better Auth options it sets. */
function applyStatelessPreset(preset: AuthStatelessPreset, options: Record<string, unknown>): Record<string, unknown> {
  if (options.database !== undefined) {
    throw authErrorDiagnostics.AUTH_C0042({ message: "`stateless()` keeps sessions in cookies and cannot use `database`. Remove `database`, or remove the preset to store sessions in a database." })
  }
  if (options.secondaryStorage !== undefined) {
    throw authErrorDiagnostics.AUTH_C0043({ message: "`stateless()` keeps sessions in cookies and cannot use `secondaryStorage`. Remove `secondaryStorage`, or remove the preset to store sessions on the server." })
  }
  if (readPath(options, ["emailAndPassword", "enabled"]) === true) {
    throw authErrorDiagnostics.AUTH_C0044({ message: "`stateless()` has no database to store users and passwords, so `emailAndPassword` cannot be enabled. Use `socialProviders`, or remove the preset and configure a database." })
  }
  const plugin = Array.isArray(options.plugins) ? options.plugins.map(storedPluginId).find(Boolean) : undefined
  if (plugin) {
    throw authErrorDiagnostics.AUTH_C0045({ message: `\`stateless()\` has no database, and the Better Auth plugin "${plugin}" stores data in one. Remove the plugin, or remove the preset and configure a database.` })
  }
  const owned = statelessOwnedOptions.find(path => readPath(options, path) !== undefined)
  if (owned) {
    throw authErrorDiagnostics.AUTH_C0046({ message: `\`stateless()\` sets \`${owned.join(".")}\`. Remove it from the Auth Definition, and pass \`maxAge\` to \`stateless()\` to change the session lifetime.` })
  }

  const session = isPlainObject(options.session) ? options.session : {}
  const cookieCache = isPlainObject(session.cookieCache) ? session.cookieCache : {}
  const account = isPlainObject(options.account) ? options.account : {}
  return {
    ...options,
    account: {
      ...account,
      storeAccountCookie: true,
      storeStateStrategy: "cookie",
    },
    session: {
      ...session,
      cookieCache: {
        ...cookieCache,
        enabled: true,
        maxAge: preset.maxAge,
        refreshCache: true,
        strategy: "jwe",
      },
      expiresIn: preset.maxAge,
    },
  }
}

/** Validates the `preset` option and returns the options with the preset's Better Auth options applied. */
export function applyAuthPreset<TOptions extends Record<string, unknown>>(options: TOptions): TOptions {
  if (options.preset === undefined) return options
  const { preset, ...rest } = options
  // SAFETY: The preset adds only Better Auth session and account options to the same option object.
  return applyStatelessPreset(readStatelessPreset(preset), rest) as TOptions
}
