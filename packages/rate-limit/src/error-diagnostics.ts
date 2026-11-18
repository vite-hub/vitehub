import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const rateLimitErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/rate-limit/diagnostics",
  codes: {
    // Operation errors. The `rate-limit.*` operations of the CLI, the Console, and Agents throw them.
    RATE_LIMIT_OPERATION_FAILED: {
      why: "The Rate Limit operation failed.",
      fix: "Read `error.cause` for the driver error. Check that the store of the Rate Limit is reachable, then retry.",
    },

    // Published numbered errors.
    RATE_LIMIT_R0001: {
      ...dynamicError,
      fix: "Call `requireRateLimit()` or `checkRateLimit()` at the place that the message names with a static string ID and an object literal of static `limit`, `window`, `enforcement`, and `failure` options, without spreads. `key` can stay a runtime value.",
    },
    RATE_LIMIT_R0002: {
      ...dynamicError,
      fix: "Fix the syntax error in the file that the message names, so that ViteHub can read its Rate Limits.",
    },
    RATE_LIMIT_R0003: {
      ...dynamicError,
      fix: "Give the files that the message lists the same `limit`, `window`, `enforcement`, and `failure` for this Rate Limit ID, or use a different ID for each policy.",
    },
    RATE_LIMIT_R0004: {
      ...dynamicError,
      fix: "Pass `cloudflareRateLimitDriver({ binding })` the Rate Limiting binding from the Worker `env`, the object that has a `limit()` method.",
    },
    RATE_LIMIT_R0005: {
      ...dynamicError,
      fix: "Read `error.cause` for the error of the Cloudflare Rate Limiting binding and check the `ratelimits` binding of the Worker. A retry can help when Cloudflare had a short outage.",
    },
    RATE_LIMIT_R0006: {
      ...dynamicError,
      fix: "Check that the binding that you pass to `cloudflareRateLimitDriver()` is a Cloudflare Rate Limiting binding, whose `limit()` returns `{ success }`.",
    },
    RATE_LIMIT_R0007: {
      ...dynamicError,
      fix: "Set `maxEntries` of `memoryRateLimitDriver()` to a whole number of 1 or more, or remove it to keep 100000.",
    },
    RATE_LIMIT_R0008: {
      ...dynamicError,
      fix: "Set a larger `maxEntries` in `memoryRateLimitDriver()`, or use the `kv` driver, which keeps its counters out of process memory.",
    },
    RATE_LIMIT_R0009: {
      ...dynamicError,
      fix: "Build the app for the Cloudflare host, so that the build adds the Rate Limiting bindings to the Wrangler config, and deploy the Worker with that config.",
    },
    RATE_LIMIT_R0010: {
      ...dynamicError,
      fix: "Pass a non-empty static string ID, such as `\"image-upload\"`, as the second argument of `requireRateLimit()` or `checkRateLimit()`.",
    },
    RATE_LIMIT_R0011: {
      ...dynamicError,
      fix: "Pass only `key`, `limit`, `window`, `enforcement`, and `failure` in the options of `checkRateLimit()`. `requireRateLimit()` also accepts `message` and `code`.",
    },
    RATE_LIMIT_R0012: {
      ...dynamicError,
      fix: "Pass `key` as a non-empty string, such as the user ID, or remove `key` to limit by the client address.",
    },
    RATE_LIMIT_R0013: {
      ...dynamicError,
      fix: "Pass `key`, such as the user or tenant ID, to `requireRateLimit()` or `checkRateLimit()` when the request has no client address.",
    },
    RATE_LIMIT_R0015: {
      ...dynamicError,
      fix: "Remove `enforcement: \"strict\"` from this Rate Limit to use the Cloudflare binding, or use the `kv` driver for strict counts.",
    },
    RATE_LIMIT_R0016: {
      ...dynamicError,
      fix: "Set `window` of this Rate Limit to \"10s\" or \"1m\" to use the Cloudflare binding, or use the `kv` driver for other windows.",
    },
    RATE_LIMIT_R0019: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: add `capabilities` with `enforcement`, `scope`, and `rejectedAttempts`.",
    },
    RATE_LIMIT_R0020: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: set `capabilities.enforcement` to \"best-effort\" or \"strict\".",
    },
    RATE_LIMIT_R0021: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: set `capabilities.scope` to \"process\", \"location\", or \"global\".",
    },
    RATE_LIMIT_R0022: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: set `capabilities.rejectedAttempts` to \"counted\", \"not-counted\", or \"unknown\".",
    },
    RATE_LIMIT_R0023: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: list `capabilities.windows` as an array of whole numbers of milliseconds, or remove it to accept every window.",
    },
    RATE_LIMIT_R0024: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `remaining`, `retryAfter`, and `used` from `consume()` as whole numbers of 0 or more, or leave them out.",
    },
    RATE_LIMIT_R0025: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `[undefined, { allowed }]` from `consume()`, with `allowed` as a boolean.",
    },
    RATE_LIMIT_R0026: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `resetAt` from `consume()` as a Unix timestamp in milliseconds, or leave it out.",
    },
    RATE_LIMIT_R0027: {
      ...dynamicError,
      fix: "Remove `enforcement: \"strict\"` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()`, or use a driver with strict enforcement, such as the memory or kv driver.",
    },
    RATE_LIMIT_R0028: {
      ...dynamicError,
      fix: "Set `window` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to one of the windows that the message lists, or use a driver without a window limit.",
    },
    RATE_LIMIT_R0029: {
      ...dynamicError,
      fix: "Pass `createRateLimiter()` a plain object with a `driver`, such as `memoryRateLimitDriver()`, and the `limit` and `window` of the policy.",
    },
    RATE_LIMIT_R0030: {
      ...dynamicError,
      fix: "Pass `consume({ key })` a non-empty string `key`, such as the user ID or the client address.",
    },
    RATE_LIMIT_R0031: {
      ...dynamicError,
      fix: "Set `window` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to a duration string such as \"10s\", \"1m\", \"1h\", or \"1d\".",
    },
    RATE_LIMIT_R0032: {
      ...dynamicError,
      fix: "Set `window` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to a duration greater than zero and shorter than 100000000 days.",
    },
    RATE_LIMIT_R0033: {
      ...dynamicError,
      fix: "Pass the Rate Limit policy as an object with `limit` and `window`, such as `{ limit: 10, window: \"1m\" }`.",
    },
    RATE_LIMIT_R0034: {
      ...dynamicError,
      fix: "Set `limit` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to a whole number of 1 or more.",
    },
    RATE_LIMIT_R0035: {
      ...dynamicError,
      fix: "Set `enforcement` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to \"best-effort\" or \"strict\", or remove it.",
    },
    RATE_LIMIT_R0036: {
      ...dynamicError,
      fix: "Set `failure` in the options of `requireRateLimit()`, `checkRateLimit()`, or `createRateLimiter()` to \"allow\" or \"deny\", or remove it.",
    },
    RATE_LIMIT_R0037: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `[undefined, { used }]` from `peek()`, with `used` as a whole number of 0 or more and an optional `resetAt` in milliseconds.",
    },
    RATE_LIMIT_R0038: {
      ...dynamicError,
      fix: "Pass `peek({ key })` or `reset({ key })` a non-empty string `key`.",
    },
    RATE_LIMIT_R0039: {
      ...dynamicError,
      fix: "Pass `peekRateLimit(id, key)` or `resetRateLimit(id, key)` the stable ID of a `requireRateLimit()` call and a non-empty key.",
    },
    RATE_LIMIT_R0040: {
      ...dynamicError,
      fix: "Run `vitehub rate-limit peek <id> <key>` or `vitehub rate-limit reset <id> <key>` with only the options that `--help` lists. Put `--` before a key that starts with a dash.",
    },
    RATE_LIMIT_R0041: {
      ...dynamicError,
      fix: "Pass `--timeout` as a whole number of milliseconds from 1 to 2147483647, such as `--timeout 5000`.",
    },
    RATE_LIMIT_R0042: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `[undefined, undefined]` from `reset()`, or `[error, undefined]` for an outage.",
    },
    RATE_LIMIT_R0043: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `[undefined, result]` from `peek()`, or `[error, undefined]` for an outage.",
    },
    RATE_LIMIT_R0044: {
      ...dynamicError,
      fix: "Fix the custom driver that you pass to `createRateLimiter()`: return `[undefined, result]` from `consume()`, or `[error, undefined]` for an outage.",
    },
    RATE_LIMIT_R0045: {
      ...dynamicError,
      fix: "Use a shorter `window` in the Rate Limit policy. With `memoryRateLimitDriver({ now })`, return the current time in milliseconds from `now`.",
    },
    RATE_LIMIT_R0046: {
      ...dynamicError,
      fix: "Pass `kv` or `kv.store(name)` from `@vite-hub/kv` as the `storage` option to `kvRateLimitDriver()`.",
    },
    RATE_LIMIT_R0047: {
      ...dynamicError,
      fix: "Enable KV in the app and build again. For a custom runtime, pass the KV driver, storage, and store name to `setRateLimitRuntimeConfig()`.",
    },
    RATE_LIMIT_B0001: { ...dynamicError, fix: "Set `rateLimit: { namespace }` in `vitehub()`, or `namespace` in `hubRateLimit()`, to a name that is different for each Worker and environment, such as `\"acme-api-production\"`." },
    RATE_LIMIT_B0002: { ...dynamicError, fix: "Set `driver: \"kv\"` in `hubRateLimit()` with a Redis or Upstash KV store, or call `createRateLimiter()` with your own driver." },
    RATE_LIMIT_B0003: { ...dynamicError, fix: "Set `driver` in `hubRateLimit()` to `\"cloudflare\"` or `\"kv\"`, or to `\"memory\"` only for a deploy with one server process." },
    RATE_LIMIT_B0004: { ...dynamicError, fix: "Write every file that declares a Rate Limit before `vite build` starts. Do not create or change these files from a plugin during the build." },
    RATE_LIMIT_KV_RUNTIME_STORE_UNSUPPORTED: {
      ...dynamicError,
      fix: "Use a KV driver that every server process shares: Redis, a Postgres Database, or Upstash. To count in the memory of each process instead, pass `memoryFallback: true` to `setRateLimitRuntimeConfig()`.",
    },
    RATE_LIMIT_KV_STORE_UNSUPPORTED: {
      ...dynamicError,
      fix: "Use a KV driver that every server process shares: `kv: { driver: 'redis' }`, a Postgres Database, or Upstash. Or remove `driver: 'kv'` to let ViteHub choose.",
    },
    RATE_LIMIT_KV_TIMEOUT: {
      why: "The KV store did not answer the Rate Limit within 1000 milliseconds.",
      fix: "Check that the KV store of the Rate Limit is reachable and not overloaded, then retry. Until it answers, `consume()` applies the `failure` policy of the Rate Limit.",
    },
    RATE_LIMIT_MEMORY_PER_PROCESS: {
      why: "Rate Limit counts requests in the memory of each server process. With several instances, each one allows the full limit.",
      fix: "Enable KV on Node so that ViteHub selects the kv driver, or set `rateLimit.driver` to \"kv\" and configure a Redis KV store or a Postgres Database. Keep `memory` only for one server process.",
    },
    RATE_LIMIT_MEMORY_STRICT_UNSUPPORTED: {
      ...dynamicError,
      fix: "Count in a shared store: on Node, set `rateLimit: { driver: 'kv' }` with a Redis or Postgres KV store. Or set `enforcement: 'best-effort'` on the Rate Limit.",
    },
    RATE_LIMIT_REFUSAL_OPTION_INVALID: {
      ...dynamicError,
      fix: "Pass `message` and `code` of `requireRateLimit()` as non-empty strings, such as `message: \"Too many tries. Wait a minute.\"`, or remove them to use the default `429` error.",
    },
    RATE_LIMIT_RENAMED_PROVIDER_KEY: {
      why: ({ value }: { value: string }) => `\`rateLimit.provider\` is ${value}. ViteHub renamed this key to \`driver\`, and it does not read \`provider\`, so Rate Limit would not use the driver you chose.`,
      fix: ({ value }: { value: string }) => `Set \`rateLimit: { driver: ${value} }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
  },
})
