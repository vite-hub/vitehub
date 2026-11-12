import { defineErrors } from "@vite-hub/runtime"

import type { KVOperation } from "./types.ts"

const cursorProblems = {
  "expired": "The list cursor has expired.",
  "foreign": "The list cursor belongs to a different storage backend.",
  "in-use": "The list cursor is already in use.",
  "invalid": "The list cursor is invalid or exceeds the maximum size.",
} as const

export type KVCursorProblem = keyof typeof cursorProblems

// Keep published codes stable. Each code has a heading on the docs page.
export const kvErrorDiagnostics = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/kv/diagnostics",
  codes: {
    // Runtime errors. KV operations return them as `[error, undefined]`.
    KV_INVALID_CURSOR: {
      why: ({ problem }: { problem: KVCursorProblem }) => cursorProblems[problem],
      fix: "Pass the `cursor` of the previous page once, to the same store. If it fails, start again without `cursor`.",
    },
    KV_INVALID_LIMIT: {
      why: "`limit` must be a positive integer.",
      fix: "Pass a positive integer, for example `kv.list({ limit: 100 })`.",
    },
    KV_INVALID_TTL: {
      why: "`ttl` must be a positive number of seconds within the safe integer range.",
      fix: "Pass the TTL in seconds, for example `kv.increment('attempts', 60)`.",
    },
    KV_KEY_TOO_LONG: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `The key is ${bytes} bytes in UTF-8. Cloudflare KV accepts keys of at most ${limit} bytes.`,
      fix: "Use a shorter key. To keep a long identifier, store a hash of it as the key.",
    },
    KV_METADATA_TOO_LARGE: {
      why: ({ bytes, limit }: { bytes: number, limit: number }) => `The metadata is ${bytes} bytes as JSON. Cloudflare KV accepts metadata of at most ${limit} bytes.`,
      fix: "Keep only small fields in `metadata`, and put the other data in the value.",
    },
    KV_TTL_TOO_SHORT: {
      why: ({ minimum, option = "expirationTtl", ttl }: { minimum: number, option?: "expiration" | "expirationTtl", ttl: number }) => option === "expiration"
        ? `\`expiration\` is ${ttl} seconds from now. Cloudflare KV needs at least ${minimum} seconds.`
        : `\`expirationTtl\` is ${ttl} seconds. Cloudflare KV needs at least ${minimum} seconds.`,
      fix: "Pass `expirationTtl: 60` or more, an `expiration` at least 60 seconds in the future, or `ttl`, which ViteHub raises to 60 seconds on Cloudflare KV.",
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
        : `kv.${operation}() needs atomic operations, and the "${store}" store does not support them.`,
      fix: ({ operation }: { operation: KVOperation, store: string }) => operation === "setIfAbsent"
        ? "On Cloudflare, keep single-use tokens in D1 with `INSERT ... ON CONFLICT DO NOTHING`, or in a Durable Object. Otherwise use the `redis`, `database`, `upstash`, `deno-kv`, or `fs-lite` driver for this store."
        : "Use the `redis`, `database`, or `upstash` driver for this store. For request budgets, use the Rate Limit primitive.",
    },

    // Config errors. KV throws them because the code or the deployment must change.
    KV_DATABASE_UNAVAILABLE: {
      why: ({ database, problem }: { database: string, problem: "missing" | "unsupported" }) => problem === "missing"
        ? `The KV \`database\` driver keeps keys in the Database "${database}", and the app has no Database with that name.`
        : `The KV \`database\` driver needs the Database "${database}" on Postgres or libSQL. It does not support D1.`,
      fix: ({ problem }: { database: string, problem: "missing" | "unsupported" }) => problem === "missing"
        ? "Add a Database Definition, for example `server/database.ts` with `defineDatabase({ dialect: 'postgresql', schema: {} })`, or select another KV driver."
        : "On Cloudflare, use the `cloudflare-kv-binding` driver. Elsewhere, point the Database at Postgres or libSQL.",
    },
    KV_DENO_KV_UNAVAILABLE: {
      why: "The `deno-kv` driver needs `Deno.openKv()`, and this runtime does not have it.",
      fix: "Run on Deno with KV enabled, or select another KV driver.",
    },
    KV_DISABLED: {
      why: "KV is not configured in this runtime.",
      fix: "Set `kv` in `vitehub()` to `true` or to a KV config. With `@vite-hub/kv` alone, add `hubKv()` to the Vite plugins and do not pass `false` to it.",
    },
    KV_INVALID_CONFIG: {
      why: ({ path }: { path: "kv" | "kv.stores" }) => `\`${path}\` must be a plain object.`,
      fix: "Pass an object, for example `kv: { driver: 'fs-lite' }`.",
    },
    KV_INVALID_DRIVER: {
      why: ({ driver }: { driver: string }) => `\`kv.driver\` ${driver} is not a KV driver.`,
      fix: "Set `kv.driver` to \"cloudflare-kv-binding\", \"database\", \"deno-kv\", \"fs-lite\", \"redis\", or \"upstash\".",
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
        ? "Remove `remote: true`, or select a remote store: the `upstash` or `cloudflare-kv-binding` driver, Upstash env, or the Vercel or Cloudflare preset."
        : "Remove `remote: false`, or select a local driver such as `fs-lite` for `vite dev`.",
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
      why: ({ store }: { store: string }) => `The KV store "${store}" is not configured.`,
      fix: "Add the store under `kv.stores`, or use the name of a configured store.",
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
      fix: "Run `vitehub provision run --provider cloudflare --dry-run` and check the Cloudflare token permissions.",
    },
  },
})

/** Codes that a KV operation throws because the code or the deployment must change. */
export const kvConfigErrorCodes: ReadonlySet<string> = new Set([
  "KV_DATABASE_UNAVAILABLE",
  "KV_DENO_KV_UNAVAILABLE",
  "KV_DISABLED",
  "KV_MISSING_ENV",
  "KV_STORE_NOT_FOUND",
])
