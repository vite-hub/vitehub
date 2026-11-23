import { defineErrors } from "@vite-hub/runtime"
import type { InferDiagnosticCodes } from "nostics"

import type { KVOperation } from "./types.ts"

const cursorProblems = {
  "expired": "The list cursor has expired.",
  "foreign": "The list cursor belongs to a different storage backend.",
  "in-use": "The list cursor is already in use.",
  "invalid": "The list cursor is invalid or exceeds the maximum size.",
} as const

export type KVCursorProblem = keyof typeof cursorProblems

export const kvErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/kv/diagnostics",
  codes: {
    // Runtime errors.
    KV_INVALID_CLEAR_OPTIONS: {
      why: "`kv.clear()` needs an options object with an optional string `prefix`, or no argument. It rejects a legacy string argument before deleting any keys.",
      fix: "Use `kv.clear({ prefix: 'drafts:' })` to clear the keys below `drafts`, or `kv.clear()` to clear the whole store.",
    },
    KV_INVALID_CURSOR: {
      why: ({ problem }: { problem: KVCursorProblem }) => cursorProblems[problem],
      fix: "Pass the `cursor` of the previous page once, to the same store. If it fails, start again without `cursor`.",
    },
    KV_INVALID_LIMIT: {
      why: "`limit` must be a positive integer.",
      fix: "Pass a positive integer, for example `kv.list({ limit: 100 })`.",
    },
    KV_INVALID_OPTION: {
      why: ({ operation, option }: { operation: "set" | "setIfAbsent" | "setMany", option: string }) => `kv.${operation}() does not accept the option \`${option}\`. It accepts only \`ttl\`.`,
      fix: "Pass `{ ttl: seconds }` to expire the value, or no options to keep it. KV has no Cloudflare `expirationTtl`, `expiration`, or `metadata` option.",
    },
    KV_INVALID_TTL: {
      why: "`ttl` must be a positive number of seconds within the safe integer range, or a duration such as `\"1h\"`.",
      fix: "Pass the TTL in seconds or as a duration, for example `kv.set('session', value, { ttl: 60 })` or `kv.set('session', value, { ttl: \"1h\" })`.",
    },
    KV_INVALID_VALUE: {
      why: ({ operation, problem }: { operation: "deleteIfEquals" | "setIfAbsent", problem: "missing" | "unserializable" }) => problem === "missing"
        ? `kv.${operation}() needs a value. Use kv.delete() to remove a key.`
        : "KV cannot serialize this value.",
      fix: "Pass a string, a number, a boolean, `null`, an array, a plain object, or an object with `toJSON()` to `kv.setIfAbsent()` or `kv.deleteIfEquals()`. Use `kv.delete()` to remove a key.",
    },
    KV_INVALID_WAIT: {
      why: "`wait` must be zero or a positive number of seconds.",
      fix: "Pass the wait in seconds, for example `kv.lock('jobs:report', { ttl: 60, wait: 5 })`, or omit `wait` to return at once.",
    },
    KV_KEY_TOO_LONG: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `The key is ${bytes} bytes in UTF-8. Cloudflare KV accepts keys of at most ${limit} bytes.`,
      fix: "Use a shorter key. To keep a long identifier, store a hash of it as the key.",
    },
    KV_VALUE_TOO_LARGE: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `The value is ${bytes} bytes. Cloudflare KV accepts values of at most ${limit} bytes (25 MiB).`,
      fix: "Store large files in Blob, and keep the Blob pathname in KV.",
    },
    KV_OPERATION_FAILED: {
      why: ({ operation, store }: { operation: KVOperation, store: string }) => `kv.${operation}() failed on the "${store}" store.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again.",
    },
    KV_UNSUPPORTED_OPERATION: {
      why: ({ operation, store }: { operation: KVOperation, store: string }) => operation === "setIfAbsent"
        ? `kv.setIfAbsent() needs an atomic write, and the "${store}" store cannot give one. Cloudflare KV is eventually consistent, so two requests can both see a missing key.`
        : operation === "lock"
          ? `kv.lock() needs \`setIfAbsent()\` with a TTL and \`deleteIfEquals()\`, and the "${store}" store does not support both.`
          : `kv.${operation}() needs atomic operations, and the "${store}" store does not support them.`,
      fix: ({ operation }: { operation: KVOperation, store: string }) => operation === "setIfAbsent"
        ? "On Cloudflare, keep single-use tokens in D1 with `INSERT ... ON CONFLICT DO NOTHING`, or in a Durable Object. Otherwise use the `redis`, `database`, `upstash`, `deno-kv`, or `fs-lite` driver for this store."
        : operation === "lock"
          ? "Use the `redis`, `database`, or `upstash` driver for this store. On Cloudflare, use a Durable Object or a D1 row as the lock."
          : "Use the `redis`, `database`, or `upstash` driver for this store. For request budgets, use the Rate Limit primitive.",
    },

    // Operation errors.
    KV_INVALID_INPUT: {
      why: ({ limit, operation, problem }: { limit?: number, operation?: string, problem: "key" | "key-length" | "limit" | "prefix-length" | "ttl" | "value" }) => ({
        "key": `The ${operation} operation requires a key.`,
        "key-length": "The key is too long.",
        "limit": `limit must be at most ${limit}.`,
        "prefix-length": "The prefix is too long.",
        "ttl": "Upstash TTL must be at least 1 second.",
        "value": "The set operation requires a value.",
      })[problem],
      fix: "Pass a `key` and a `prefix` of at most 2,048 characters, a `limit` of at most 1,000, and, for `kv.set`, a `value`. On Upstash, pass a `ttl` of at least 1 second.",
    },
    KV_RESERVED_KEY: {
      why: ({ key, operation }: { key: string, operation: string }) => `The ${operation} operation cannot change ${key}. ViteHub owns the keys that start with \`vitehub:\`.`,
      fix: "Use another key. Read access (get, has, list) stays open.",
    },
    KV_VALUE_UNSUPPORTED: {
      why: "The stored value cannot be represented by the KV inspection protocol.",
      fix: "Read the value in the app with `kv.get()`. The `kv.get` operation shows JSON values, bigint values, and bytes, without getters, symbols, or class instances.",
    },

    // Config errors.
    KV_DATABASE_UNAVAILABLE: {
      why: ({ database, problem }: { database: string, problem: "missing" | "unsupported" }) => problem === "missing"
        ? `The KV \`database\` driver keeps keys in the Database "${database}", and the app has no Database with that name.`
        : `The KV \`database\` driver needs the Database "${database}" on postgres.js, libSQL, or Cloudflare D1.`,
      fix: ({ problem }: { database: string, problem: "missing" | "unsupported" }) => problem === "missing"
        ? "Add a Database Definition, for example `server/database.ts` with `defineDatabase({ dialect: 'postgresql', schema: {} })`, or select another KV driver."
        : "Point the Database at postgres.js, libSQL, or a Cloudflare D1 binding, or select another KV driver.",
    },
    KV_DENO_KV_UNAVAILABLE: {
      why: "The `deno-kv` driver needs `Deno.openKv()`, and this runtime does not have it.",
      fix: "Run on Deno with KV enabled, or select another KV driver.",
    },
    KV_DISABLED: {
      why: "KV is not configured in this runtime.",
      fix: "Set `kv` in `vitehub()` to `true` or to a KV config. With `@vite-hub/kv` alone, add `hubKV()` to the Vite plugins and do not pass `false` to it.",
    },
    KV_INVALID_CONFIG: {
      why: ({ path }: { path: "kv" | "kv.stores" }) => `\`${path}\` must be a plain object.`,
      fix: "Pass an object, for example `kv: { driver: 'fs-lite' }`.",
    },
    KV_INVALID_DRIVER: {
      why: ({ driver, renamed }: { driver: string, renamed?: string }) => renamed
        ? `\`kv.driver\` is ${driver}. ViteHub renamed this driver to "${renamed}", and it does not read ${driver}.`
        : `\`kv.driver\` ${driver} is not a KV driver.`,
      fix: ({ renamed }: { driver: string, renamed?: string }) => renamed
        ? `Set \`kv: { driver: "${renamed}" }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`
        : "Set `kv.driver` to \"cloudflare\", \"database\", \"deno-kv\", \"fs-lite\", \"redis\", or \"upstash\".",
    },
    KV_INVALID_REMOTE: {
      why: ({ store }: { store: string }) => `\`remote\` of the KV store "${store}" must be \`true\` or \`false\`.`,
      fix: "Set `remote: true` to use the real store in `vite dev`, or remove `remote` to keep the store local.",
    },
    KV_REMOTE_CONFLICT: {
      why: ({ driver, remote, store }: { driver: string, remote: boolean, store: string }) => remote
        ? `The KV store "${store}" sets \`remote: true\`, but it uses the local \`${driver}\` driver in \`vite dev\`.`
        : `The KV store "${store}" sets \`remote: false\`, but the \`${driver}\` driver is always remote.`,
      fix: ({ remote }: { driver: string, remote: boolean, store: string }) => remote
        ? "Remove `remote: true`, or select a remote store: the `upstash` or `cloudflare` driver, Upstash env, or the Vercel or Cloudflare host."
        : "Remove `remote: false`, or select a local driver such as `fs-lite` for `vite dev`.",
    },
    KV_INVALID_BATCH: {
      why: ({ operation }: { operation: "getMany" | "setMany" }) => operation === "getMany"
        ? "`kv.getMany()` needs an array of keys."
        : "`kv.setMany()` needs an array of `{ key, value }` entries.",
      fix: ({ operation }: { operation: "getMany" | "setMany" }) => operation === "getMany"
        ? "Pass an array, for example `kv.getMany(['a', 'b'])`."
        : "Pass an array, for example `kv.setMany([{ key: 'a', value: 1 }])`.",
    },
    KV_INVALID_STORE_MODE: {
      why: ({ mode }: { mode: string }) => `\`kv.store()\` mode ${mode} is not "read" or "write".`,
      fix: "Pass `{ mode: 'read' }` for a read-only handle, or omit `mode` for a writable one.",
    },
    KV_MISSING_DEFAULT_STORE: {
      why: "`kv.stores.default` is missing.",
      fix: "Add a `default` store when you configure named KV stores.",
    },
    KV_MISSING_ENV: {
      why: ({ driver, names }: { driver: "redis" | "upstash", names: string }) => `${driver === "redis" ? "Redis" : "Upstash"} KV needs the runtime environment variable ${names}.`,
      fix: ({ driver }: { driver: "redis" | "upstash", names: string }) => driver === "redis"
        ? "Set the variable in the server environment, or set `url` in the KV config."
        : "Set the variable in the host environment, or set `url` and `token` in the KV config.",
    },
    KV_STORE_NOT_FOUND: {
      why: ({ store, stores }: { store: string, stores?: string }) => stores ? `KV store "${store}" was not found. Stores: ${stores}.` : `The KV store "${store}" is not configured.`,
      fix: "Add the store under `kv.stores`, or use the name of a configured store.",
    },
    KV_UNKNOWN_STORE_OPTION: {
      why: ({ driver, key, path, stores }: { drivers: readonly string[], driver?: string, key: string, path: string, stores?: true }) => stores
        ? `\`${path}\` has \`stores\`, so it takes no other key, and it has \`${key}\`.`
        : driver
          ? `\`${path}.${key}\` is not an option of the \`${driver}\` KV driver.`
          : `\`${path}.${key}\` is not an option of a KV store without \`driver\`. ViteHub picks the driver from the host and would ignore it.`,
      fix: ({ drivers, driver, key, stores }: { drivers: readonly string[], driver?: string, key: string, path: string, stores?: true }) => stores
        ? `Move \`${key}\` into a store under \`stores\`, for example \`stores: { default: { driver: "fs-lite" } }\`.`
        : drivers.length && !driver
          ? `Set \`driver\` to ${drivers.map(name => `"${name}"`).join(" or ")}, which reads \`${key}\`. ViteHub renamed some drivers, so run \`npx @vite-hub/codemods driver-key\` when the config had an old driver name.`
          : drivers.length
            ? `Remove \`${key}\`, or set \`driver\` to ${drivers.map(name => `"${name}"`).join(" or ")}, which reads it.`
            : `Remove \`${key}\`. A KV store takes \`driver\`, \`remote\`, and the options of its driver.`,
    },

    // Provider and tool errors.
    KV_INVALID_COUNTER: {
      why: "kv.increment() needs a stored integer below 9007199254740991. The value did not change.",
      fix: "Delete the key or replace its value with a canonical integer below Number.MAX_SAFE_INTEGER, then retry kv.increment().",
    },
    KV_CLI_USAGE: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Run `vitehub kv --help` to see the commands and options.",
    },
    KV_PROVIDER_INVALID_RESPONSE: {
      why: ({ problem }: { problem: string }) => `The KV provider returned a response that ViteHub cannot use. ${problem}`,
      fix: "Retry the operation. If it fails again, open a ViteHub issue with the driver name.",
    },
    KV_PROVISION_FAILED: {
      why: ({ problem }: { problem: string }) => `Cloudflare KV provisioning failed. ${problem}`,
      fix: "Run `vitehub provision run --host cloudflare --dry-run` and check the Cloudflare token permissions.",
    },

    KV_REDIS_URL_UNUSED: {
      why: ({ name, store }: { name: string, store: string }) => store === "upstash"
        ? `KV on Vercel uses Upstash, and the build has no \`KV_REST_API_URL\` and \`KV_REST_API_TOKEN\`, so KV fails at runtime. The build has \`${name}\`, and KV does not select Redis on its own.`
        : `The build has \`${name}\`, but KV does not select Redis on its own. The KV store "default" uses ${store}.`,
      fix: ({ name }: { name: string, store: string }) => `To keep KV in that Redis, set \`kv: { driver: "redis"${name === "REDIS_URL" ? "" : `, url: "env:${name}"`} }\`. To keep this store, set its \`driver\`.`,
    },
  },
})

/** Codes that a KV operation throws because the code or the deployment must change. */
export const kvConfigErrorCodes: ReadonlySet<InferDiagnosticCodes<typeof kvErrorDiagnostics>> = new Set([
  "KV_DATABASE_UNAVAILABLE",
  "KV_INVALID_BATCH",
  "KV_DENO_KV_UNAVAILABLE",
  "KV_DISABLED",
  "KV_MISSING_ENV",
  "KV_STORE_NOT_FOUND",
])
