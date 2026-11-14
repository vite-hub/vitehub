import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: VITE_HUB_B0002, VITE_HUB_B0003, VITE_HUB_B0007, VITE_HUB_B0010, VITE_HUB_B0014, VITE_HUB_R0002 to VITE_HUB_R0039, VITE_HUB_R0048, VITE_HUB_R0064 to VITE_HUB_R0069, VITE_HUB_R0099, VITE_HUB_R0100, VITE_HUB_R0105, VITE_HUB_R0110 to VITE_HUB_R0112, VITE_HUB_R0122, and VITE_HUB_R0134.
export const viteHubErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    CACHE_DRIVER_WRONG_HOST: {
      why: ({ driver, host, required }: { driver: string, host: string, required: string }) => `\`cache.driver: "${driver}"\` needs the ${required} host, but the host is ${host}.`,
      fix: "Use the `cache.driver` of your host, or set `cache: { driver: \"kv\" }` with `kv` enabled, which works on every host.",
    },
    CACHE_INVALID_INPUT: {
      ...dynamicError,
      fix: "Pass a cache key or a non-empty prefix, and a list limit from 1 to 100. Prefix deletion cannot clear the whole cache.",
    },
    CACHE_KV_DISABLED: {
      why: "`cache.driver: \"kv\"` keeps the Nitro cache in KV, but `kv` is not enabled.",
      fix: "Set `kv: true` in `vitehub()`, or choose another `cache.driver`.",
    },
    CACHE_NAMESPACE_ID_CONFLICT: {
      why: ({ binding, existing, requested }: { binding: string, existing: string, requested: string }) => `The Cloudflare cache binding "${binding}" already uses the KV namespace "${existing}", but \`cache.namespaceId\` asks for "${requested}".`,
      fix: "Make `cache.namespaceId` the same as the `id` of this binding in the `kv_namespaces` of the Wrangler config, or remove one of them.",
    },
    CACHE_NAMESPACE_ID_MISSING: {
      why: ({ binding }: { binding: string }) => `The Cloudflare cache binding "${binding}" has no KV namespace ID.`,
      fix: "Set `cache.namespaceId` in `vitehub()` to the ID of a Cloudflare KV namespace, or add this binding with its `id` to `kv_namespaces` in the Wrangler config.",
    },
    CACHE_STORAGE_FAILED: {
      ...dynamicError,
      fix: "Check that the cache driver supports the requested storage operation. Vercel Runtime Cache cannot list keys.",
    },
    VITE_HUB_MCP_AUTH_MISSING: {
      why: "The MCP server needs Auth, so that only signed-in MCP clients call its tools.",
      fix: "Set `auth` in `vitehub()` and add `mcpOAuth()` from `vite-hub/auth/mcp` to server/auth.ts, or set `mcp: { auth: false }` to let anyone call every tool.",
    },
    VITE_HUB_PUBLIC_URL_INVALID: {
      why: ({ value }: { value: string }) => `\`publicUrl\` must be an http or https origin without a path, but it is ${value}.`,
      fix: "Set `vitehub({ publicUrl })` to an origin such as `https://shop.example.com`, with no path, query, or user name.",
    },
    VITE_HUB_R0120: {
      ...dynamicError,
      fix: "Remove `dataDir` from `vitehub()`, or set `host: \"node\"`. Other hosts keep data in remote stores.",
    },
    VITE_HUB_R0121: {
      ...dynamicError,
      fix: "Set `dataDir` in `vitehub()` to a directory path, such as `dataDir: \"/var/lib/shop\"`, or remove it.",
    },
    VITE_HUB_R0124: {
      ...dynamicError,
      fix: "Remove `database: false` from `vitehub()`, or set `connections: false`.",
    },
    VITE_HUB_R0125: {
      ...dynamicError,
      fix: "Set `observability.service` in `vitehub()` to the name of your app, such as `service: \"shop\"`.",
    },
    VITE_HUB_R0126: {
      ...dynamicError,
      fix: "Remove `env: false` from `vitehub()`, or remove `observability.posthog`.",
    },
    VITE_HUB_R0127: {
      ...dynamicError,
      fix: "Set `agent` and `console` in `vitehub()`, or remove `observability.papercuts`.",
    },
    VITE_HUB_R0128: {
      ...dynamicError,
      fix: "Rename the `observability` entry of `env.server`. ViteHub uses that name for `vitehub({ observability })`.",
    },
    VITE_HUB_R0129: {
      ...dynamicError,
      fix: "Build for a host that runs Agents in Nitro, such as Node, Cloudflare, or Vercel, or remove `observability` from `vitehub()`.",
    },
    VITE_HUB_R0131: {
      ...dynamicError,
      fix: "Set `database: true` in `vitehub()`, or choose another store in `agent.invocations`.",
    },
    VITE_HUB_R0132: {
      ...dynamicError,
      fix: "Set `agent.invocations: false` in `vitehub()` and set `invocations` on each Agent Definition, or build for a host that runs Agents in Nitro.",
    },
    VITE_HUB_R0135: {
      ...dynamicError,
      fix: "Put `vitehub()` before `nitro()` in the `plugins` list of vite.config.ts.",
    },
    VITE_HUB_R0136: {
      ...dynamicError,
      fix: "Run the `pnpm add` command that the message shows in your app, then start the build again.",
    },
    VITE_HUB_R0137: {
      ...dynamicError,
      fix: "Set `schedule: { runtime: { driver: \"process\" }, providerOutput: \"auto\" }` in `vitehub()` to run Schedules in the server process, or `schedule: { providerOutput: false }` to start them yourself.",
    },
    VITE_HUB_R0141: {
      ...dynamicError,
      fix: "Remove `queue.provider` from `vitehub()`, or set `host: \"node\"`.",
    },
    VITE_HUB_R0142: {
      ...dynamicError,
      fix: "Set vitehub({ systemd }) to one-line values: a unit name of letters, digits, and _.:-, an absolute workingDirectory, and environment names such as PORT. Or set systemd: false and write the unit yourself.",
    },
    VITE_HUB_R0143: {
      why: "This server has no durability report. ViteHub records it when a Node server starts.",
      fix: "Run the app with the Node host, then run vitehub durability list against that server.",
    },
    VITE_HUB_R0144: {
      ...dynamicError,
      fix: "Remove `rateLimit.provider` to use the preset's supported provider, or use the `node` preset to count in KV.",
    },
    VITE_HUB_R0116: dynamicError,
    VITE_HUB_R0117: dynamicError,
    VITE_HUB_R0118: dynamicError,
    VITE_HUB_R0119: dynamicError,
    VITE_HUB_R0115: dynamicError,
    VITE_HUB_R0113: dynamicError,
    VITE_HUB_R0114: dynamicError,
    VITE_HUB_R0095: dynamicError,
    VITE_HUB_R0096: dynamicError,
    VITE_HUB_R0097: dynamicError,
    VITE_HUB_R0098: dynamicError,
    VITE_HUB_R0101: dynamicError,
    VITE_HUB_R0102: dynamicError,
    VITE_HUB_R0103: dynamicError,
    VITE_HUB_R0104: dynamicError,
    VITE_HUB_R0106: dynamicError,
    VITE_HUB_R0107: dynamicError,
    VITE_HUB_R0108: dynamicError,
    VITE_HUB_R0109: dynamicError,
    VITE_HUB_R0001: {
      ...dynamicError,
      fix: "Add a KV store that uses this driver, such as `kv: { driver: \"redis\" }` or `kv: { driver: \"upstash\" }` in `vitehub()`, or remove the import of the driver from the app.",
    },
    VITE_HUB_R0040: dynamicError,
    VITE_HUB_R0041: dynamicError,
    VITE_HUB_R0042: dynamicError,
    VITE_HUB_R0043: dynamicError,
    VITE_HUB_R0044: dynamicError,
    VITE_HUB_R0045: dynamicError,
    VITE_HUB_R0046: dynamicError,
    VITE_HUB_R0047: dynamicError,
    VITE_HUB_R0049: dynamicError,
    VITE_HUB_R0050: dynamicError,
    VITE_HUB_R0051: dynamicError,
    VITE_HUB_C0001: dynamicError,
    VITE_HUB_C0002: dynamicError,
    VITE_HUB_C0003: {
      ...dynamicError,
      fix: "Remove `cache` from `vitehub()`, or set `cache: { driver: \"kv\" }` with `kv` enabled to keep the cache in KV on this host.",
    },
    VITE_HUB_C0004: {
      ...dynamicError,
      fix: "Set `cache.driver` to \"cloudflare-kv-binding\", \"deno-kv\", \"fs-lite\", \"kv\", or \"vercel-runtime-cache\".",
    },
    VITE_HUB_R0052: dynamicError,
    VITE_HUB_R0053: dynamicError,
    VITE_HUB_R0054: dynamicError,
    VITE_HUB_R0055: dynamicError,
    VITE_HUB_R0056: dynamicError,
    VITE_HUB_R0057: dynamicError,
    VITE_HUB_R0058: dynamicError,
    VITE_HUB_R0059: dynamicError,
    VITE_HUB_R0060: dynamicError,
    VITE_HUB_R0061: dynamicError,
    VITE_HUB_R0062: dynamicError,
    VITE_HUB_R0063: dynamicError,
    VITE_HUB_R0070: dynamicError,
    VITE_HUB_R0071: dynamicError,
    VITE_HUB_R0072: dynamicError,
    VITE_HUB_R0073: dynamicError,
    VITE_HUB_R0074: dynamicError,
    VITE_HUB_B0001: dynamicError,
    VITE_HUB_B0004: {
      ...dynamicError,
      fix: "Set `console` in `vitehub()` to `true`, `false`, or an object such as `{ authorize: \"./server/console-authorize.ts\", impersonation: true, sections: { content: false } }`.",
    },
    VITE_HUB_B0005: {
      ...dynamicError,
      fix: "Set `auth: true` in `vitehub()` and add server/auth.ts with the admin plugin of Better Auth, or remove `console.impersonation`.",
    },
    VITE_HUB_B0006: dynamicError,
    VITE_HUB_R0075: {
      ...dynamicError,
      fix: "Set `blob: true` in `vitehub()`, and on a host without its own Blob storage also choose a store, such as `blob: { driver: \"s3\" }`. Or remove the Blob import and the Blob Capabilities from the app.",
    },
    VITE_HUB_R0076: {
      ...dynamicError,
      fix: "Set `vitehub({ name })` to a name that has at least one letter or digit, such as `name: \"shop\"`.",
    },
    VITE_HUB_R0077: {
      ...dynamicError,
      fix: "Set `WRANGLER_CI_OVERRIDE_NAME` to a name that has at least one letter or digit, or unset it.",
    },
    VITE_HUB_R0078: {
      ...dynamicError,
      fix: "Make `vitehub({ name })` and `WRANGLER_CI_OVERRIDE_NAME` the same name, or remove one of them.",
    },
    VITE_HUB_R0079: {
      ...dynamicError,
      fix: "Set `blob: true` in `vitehub()`, or remove the Blob import that the message names.",
    },
    VITE_HUB_R0080: {
      ...dynamicError,
      fix: "Make `vitehub({ host })` and the `VITEHUB_HOST` variable name the same host, or remove one of them.",
    },
    VITE_HUB_R0081: {
      ...dynamicError,
      fix: "Remove `nitro.preset` from the config. ViteHub sets the Nitro preset from `vitehub({ host })`.",
    },
    VITE_HUB_R0082: {
      ...dynamicError,
      fix: "Unset the `NITRO_PRESET` or `SERVER_PRESET` variable that the message names, or set `vitehub({ host })` to the host that it selects.",
    },
    VITE_HUB_R0083: {
      ...dynamicError,
      fix: "Remove the `nitro.preset` that the config or another plugin sets. ViteHub sets the Nitro preset from `vitehub({ host })`.",
    },
    VITE_HUB_R0084: {
      ...dynamicError,
      fix: "Choose a Blob store that works on this host, such as `blob: { driver: \"s3\" }` in `vitehub()`, or set `blob: false`.",
    },
    VITE_HUB_R0085: {
      ...dynamicError,
      fix: "Pass an options object to `vitehub()`, such as `vitehub({ host: \"node\" })`, or call `vitehub()` with no argument.",
    },
    VITE_HUB_R0086: {
      ...dynamicError,
      fix: "Set `schedule: false` in `vitehub()`, or build for another host, such as `host: \"node\"` or `host: \"cloudflare\"`.",
    },
    VITE_HUB_R0087: {
      ...dynamicError,
      fix: "Remove `agent.runtime: \"deno\"` from `vitehub()` to run Agents in the Nitro server of the Deno host, or deploy the Deno Agent runtime to another host.",
    },
    VITE_HUB_R0088: {
      ...dynamicError,
      fix: "Set `host: \"cloudflare\"` in `vitehub()`, or remove `browser`.",
    },
    VITE_HUB_R0089: {
      ...dynamicError,
      fix: "Choose an Email driver for this host, such as `email: { driver: \"resend\" }` in `vitehub()`, or set `host: \"cloudflare\"`.",
    },
    VITE_HUB_B0008: {
      ...dynamicError,
      fix: "Remove one of the two auto-imports of this name from the Nuxt config or its modules, or rename one export.",
    },
    VITE_HUB_B0009: {
      ...dynamicError,
      fix: "Remove `nitro.preset` from nuxt.config.ts. ViteHub sets the Nitro preset from the `vitehub.host` option.",
    },
    VITE_HUB_B0011: {
      ...dynamicError,
      fix: "Remove `env.projectRoot` from the ViteHub options, or set it to the project root of the Env Vite plugin.",
    },
    VITE_HUB_B0012: {
      ...dynamicError,
      fix: "Run `pnpm add evlog` in your app, or remove `observability` from `vitehub()`.",
    },
    VITE_HUB_B0013: {
      ...dynamicError,
      fix: "Set `database: true` in `vitehub()`, or remove the Database import that the message names.",
    },
    VITE_HUB_B0015: {
      ...dynamicError,
      fix: "Set `agent.invocations.retention` in `vitehub()` to limits such as `{ maxAge: \"14d\", maxRecords: 10000 }`, or `false` for no limit.",
    },
    VITE_HUB_B0016: {
      ...dynamicError,
      fix: "Use `retention.maxAge` or `retention.maxRecords`, or set `agent.invocations.databaseUrl` to a local SQLite file, such as `file:.data/invocations.sqlite`.",
    },
    VITE_HUB_B0017: dynamicError,
    VITE_HUB_B0018: {
      ...dynamicError,
      fix: "Remove `database: false` from `vitehub()`, or set `comments: false`.",
    },
    VITE_HUB_B0019: {
      ...dynamicError,
      fix: "Remove the file that the message names, or remove `comments: false` from `vitehub()`.",
    },
    VITE_HUB_B0020: {
      ...dynamicError,
      fix: "Remove the `console` option that the message names, and make the change that the message shows.",
    },
    VITE_HUB_B0021: {
      ...dynamicError,
      fix: "Remove `agent.invocations.databaseUrl` to use the D1 binding of the default Database, or set it to a remote libSQL URL.",
    },
    VITE_HUB_B0022: {
      ...dynamicError,
      fix: "Remove `console.auth` from `vitehub()`, and set the `VITEHUB_CONSOLE_KEY_<NAME>` variable that `vitehub secret console-key` prints.",
    },
    VITE_HUB_B0023: {
      ...dynamicError,
      fix: "Upgrade to Nuxt 5, which supplies Nitro 3 and H3 2. Until Nuxt 5 is stable, run pnpm add nuxt@npm:nuxt-nightly@5x.",
    },
    VITE_HUB_B0024: {
      ...dynamicError,
      fix: "Remove the obsolete option from `vitehub()` or the `vitehub` options in nuxt.config.ts, and apply the migration shown in the error message.",
    },
  },
})
