import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: VITE_HUB_B0002, VITE_HUB_B0003, VITE_HUB_B0006, VITE_HUB_B0007, VITE_HUB_B0010, VITE_HUB_B0014, VITE_HUB_B0017, VITE_HUB_R0002 to VITE_HUB_R0039, VITE_HUB_R0048, VITE_HUB_R0055 to VITE_HUB_R0057, VITE_HUB_R0064 to VITE_HUB_R0069, VITE_HUB_R0099, VITE_HUB_R0100, VITE_HUB_R0105, VITE_HUB_R0110 to VITE_HUB_R0112, VITE_HUB_R0119, VITE_HUB_R0122, and VITE_HUB_R0134.
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
    VITE_HUB_R0116: {
      ...dynamicError,
      fix: "Send only `user` and `assistant` Messages in the `messages` history of `agents.invoke`.",
    },
    VITE_HUB_R0117: {
      ...dynamicError,
      fix: "Keep only text, file, image, and audio parts in the `messages` history of `agents.invoke`, and remove tool and approval parts.",
    },
    VITE_HUB_R0118: {
      ...dynamicError,
      fix: "Give each Message in the `messages` history of `agents.invoke` a different `id`.",
    },
    VITE_HUB_R0115: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub agent usage` page with the same `--agent`, `--window`, `--status`, and `--search`, or omit `cursor` to read the first page.",
    },
    VITE_HUB_R0113: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub agents status`.",
    },
    VITE_HUB_R0114: {
      ...dynamicError,
      fix: "Pass to `vitehub agents status --agent` the name of an Agent that `vitehub agents list` shows.",
    },
    VITE_HUB_R0095: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0096: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0097: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0098: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0101: {
      ...dynamicError,
      fix: "Check that the app runs and answers on its `/_vitehub/rpc` route, then reload the Console page.",
    },
    VITE_HUB_R0102: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0103: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0104: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0106: {
      ...dynamicError,
      fix: "Check that the app runs and answers on its `/_vitehub/rpc` route, then reload the Console page.",
    },
    VITE_HUB_R0107: {
      ...dynamicError,
      fix: "Reload the Workspace view, so that the Console reads the file at the current revision of the Workspace.",
    },
    VITE_HUB_R0108: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0109: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0001: {
      ...dynamicError,
      fix: "Add a KV store that uses this driver, such as `kv: { driver: \"redis\" }` or `kv: { driver: \"upstash\" }` in `vitehub()`, or remove the import of the driver from the app.",
    },
    VITE_HUB_R0040: {
      ...dynamicError,
      fix: "Move the app route or Nitro handler on `/_vitehub/rpc` to another path, or set `vitehub({ console: false })` to turn the Console route off.",
    },
    VITE_HUB_R0041: {
      ...dynamicError,
      fix: "Look up the error code that the app returned and fix that cause in the app. Without a code, read the app logs for the store call that failed.",
    },
    VITE_HUB_R0042: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0043: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0044: {
      ...dynamicError,
      fix: "Update `vite-hub` in the app to the version of the Console and deploy the app again, so its Console route answers in the shape that the Console reads.",
    },
    VITE_HUB_R0045: {
      ...dynamicError,
      fix: "Give the Agent a name of 1 to 512 characters without spaces at the start or the end, in its file or folder name under `server/agents/`.",
    },
    VITE_HUB_R0046: {
      ...dynamicError,
      fix: "Change the `agents.invoke`, `invocations.cancel`, `invocations.delete`, or `invocations.undo` call as the message says, with an Agent from `vitehub agents list` and an Invocation id from `vitehub invocations list`. A 409 names what the app lacks for the action, such as Realtime for undo or an invocation store that can delete.",
    },
    VITE_HUB_R0047: {
      ...dynamicError,
      fix: "Give every Agent Definition the same `invocations` journal, or remove `invocations` from the Agent Definitions, so they share the app-wide `agent.invocations` journal.",
    },
    VITE_HUB_R0049: {
      ...dynamicError,
      fix: "Enable Blob with `vitehub({ blob })` and keep the Console on, so that ViteHub installs Blob inspection before `getConsoleBlob()` runs.",
    },
    VITE_HUB_R0050: {
      ...dynamicError,
      fix: "Pass `vitehub database rows` a database and a table that `vitehub database tables` lists, a `--sort` column of that table, and a `--limit`, `--offset`, and `--search` inside the limits that the message names.",
    },
    VITE_HUB_R0051: {
      ...dynamicError,
      fix: "Enable a Database with `vitehub({ database })` and keep the Console on, so that ViteHub installs Database inspection before `getConsoleDatabase()` runs.",
    },
    VITE_HUB_C0001: {
      ...dynamicError,
      fix: "Pass a section that `vitehub project info` lists, or a Workspace, revision, and text file under 512 KiB that `vitehub workspaces files` lists. For a 502 or 503, read the app logs for the Workspace store, Env provider, or section reader that failed, then try again.",
    },
    VITE_HUB_C0002: {
      ...dynamicError,
      fix: "Enable a feature that adds a Console section, such as `vitehub({ database })`, and keep the Console on, so that ViteHub installs Definition inspection before `getConsoleDefinitions()` runs.",
    },
    VITE_HUB_C0003: {
      ...dynamicError,
      fix: "Remove `cache` from `vitehub()`, or set `cache: { driver: \"kv\" }` with `kv` enabled to keep the cache in KV on this host.",
    },
    VITE_HUB_C0004: {
      ...dynamicError,
      fix: "Set `cache.driver` to \"cloudflare-kv-binding\", \"deno-kv\", \"fs-lite\", \"kv\", or \"vercel-runtime-cache\".",
    },
    VITE_HUB_R0052: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub search query` result with the same search, or omit `cursor` to read the first page. A 409 means that the results changed after that cursor, so start again without it.",
    },
    VITE_HUB_R0053: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub invocations capabilities`.",
    },
    VITE_HUB_R0054: {
      ...dynamicError,
      fix: "Pass an Invocation id that `vitehub invocations list` shows. The journal removes old Invocations after its retention limit.",
    },
    VITE_HUB_R0058: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub invocations list` result without changes, or omit `cursor` to read the first page.",
    },
    VITE_HUB_R0059: {
      ...dynamicError,
      fix: "Pass at most 100 Invocation ids in the `id` list of `invocations.list`, and split a longer list into several calls.",
    },
    VITE_HUB_R0060: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub invocations list`.",
    },
    VITE_HUB_R0061: {
      ...dynamicError,
      fix: "Pass `capability` and `triggeredBy` values of at most 512 characters to `invocations.list` (`vitehub invocations list`).",
    },
    VITE_HUB_R0062: {
      ...dynamicError,
      fix: "Pass a whole number of 1 or more as `limit` to `invocations.list` (`vitehub invocations list --limit`).",
    },
    VITE_HUB_R0063: {
      ...dynamicError,
      fix: "Add an Agent Definition, such as `server/agents/support/agent.ts`, and keep the Console on, so that ViteHub installs the Agent journal before `getConsoleInvocations()` runs.",
    },
    VITE_HUB_R0070: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agents list` shows it, to `--agent` of `vitehub agent usage`.",
    },
    VITE_HUB_R0071: {
      ...dynamicError,
      fix: "Pass `--window` as 24h, 7d, 14d, 30d, or 90d to `vitehub agent usage`, or omit it to read 30 days.",
    },
    VITE_HUB_R0072: {
      ...dynamicError,
      fix: "Pass `vitehub agent usage` a `--status` of completed, failed, or cancelled, a `--window` of 24h, 7d, 14d, 30d, or 90d, and a `--search` of at most 512 characters.",
    },
    VITE_HUB_R0073: {
      ...dynamicError,
      fix: "Set `vitehub({ publicUrl })` to the public origin of the app, or call `invocationUrl()` while a request runs. With several origins, send the request to one of them.",
    },
    VITE_HUB_R0074: {
      ...dynamicError,
      fix: "Pass `invocationUrl()` an Invocation with a string `agentName` and `id`, such as the current Invocation of the handler.",
    },
    VITE_HUB_B0001: {
      ...dynamicError,
      fix: "Reinstall the project dependencies, so that the `vite-hub` package has its Console runtime files, then build again.",
    },
    VITE_HUB_B0004: {
      ...dynamicError,
      fix: "Set `console` in `vitehub()` to `true`, `false`, or an object such as `{ authorize: \"./server/console-authorize.ts\", impersonation: true, sections: { content: false } }`.",
    },
    VITE_HUB_B0005: {
      ...dynamicError,
      fix: "Set `auth: true` in `vitehub()` and add server/auth.ts with the admin plugin of Better Auth, or remove `console.impersonation`.",
    },
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
