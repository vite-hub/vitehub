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
  docs: "https://vitehub.dev/docs/kv/limits-and-errors",
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
    KV_OPERATION_FAILED: {
      why: ({ operation, store }: { operation: KVOperation, store: string }) => `kv.${operation}() failed on the "${store}" store.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again.",
    },
    KV_UNSUPPORTED_OPERATION: {
      why: ({ operation, store }: { operation: KVOperation, store: string }) => `kv.${operation}() needs atomic operations, and the "${store}" store does not support them.`,
      fix: "Use the `upstash` driver for this store. For request budgets, use the Rate Limit primitive.",
    },

    // Config errors. KV throws them because the code or the deployment must change.
    KV_DENO_KV_UNAVAILABLE: {
      why: "The `deno-kv` driver needs `Deno.openKv()`, and this runtime does not have it.",
      fix: "Run on Deno with KV enabled, or select another KV driver.",
    },
    KV_DISABLED: {
      why: "KV is not configured in this runtime.",
      fix: "Add `hubKv()` to the Vite config and do not set `kv: false`.",
    },
    KV_INVALID_CONFIG: {
      why: ({ path }: { path: "kv" | "kv.stores" }) => `\`${path}\` must be a plain object.`,
      fix: "Pass an object, for example `kv: { driver: 'fs-lite' }`.",
    },
    KV_INVALID_DRIVER: {
      why: ({ driver }: { driver: string }) => `\`kv.driver\` ${driver} is not a KV driver.`,
      fix: "Set `kv.driver` to \"cloudflare-kv-binding\", \"deno-kv\", \"upstash\", or \"fs-lite\".",
    },
    KV_MISSING_DEFAULT_STORE: {
      why: "`kv.stores.default` is missing.",
      fix: "Add a `default` store when you configure named KV stores.",
    },
    KV_MISSING_ENV: {
      why: ({ names }: { names: string }) => `Upstash KV needs the runtime environment variable ${names}.`,
      fix: "Set the variable in the host environment, or set `url` and `token` in the KV config.",
    },
    KV_STORE_NOT_FOUND: {
      why: ({ store }: { store: string }) => `The KV store "${store}" is not configured.`,
      fix: "Add the store under `kv.stores`, or use the name of a configured store.",
    },

    // Provider and tool errors.
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
  "KV_DENO_KV_UNAVAILABLE",
  "KV_DISABLED",
  "KV_MISSING_ENV",
  "KV_STORE_NOT_FOUND",
])
