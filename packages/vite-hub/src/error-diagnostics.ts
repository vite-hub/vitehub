import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

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
    LOGS_CURSOR_EXPIRED: {
      why: "The log cursor has expired. Refresh to read the retained events.",
      fix: "Read the logs again from the first page without a cursor. The log source no longer keeps the events that the cursor pointed to.",
    },
    SEO_PUBLIC_URL_MISSING: {
      why: ({ route }: { route: string }) => `The build prerenders \`${route}\`, which holds full URLs, but \`publicUrl\` is not set to one origin. A prerendered file has no request to take the origin from.`,
      fix: "Set `publicUrl` in `vitehub()` to the origin of the deployed app, such as `publicUrl: \"https://example.com\"`, or remove the route from `nitro.prerender.routes` so each request gives the origin.",
    },
    SEO_SITEMAP_ENTRY_INVALID: {
      why: ({ entry }: { entry: string }) => `\`server/sitemap.ts\` returned an entry that is not a page: ${entry}.`,
      fix: "Return objects such as `{ loc: \"/blog/hello\", lastmod: \"2026-11-16\" }` from `defineSitemap()`. `loc` is a path that starts with `/` or an `http(s)` URL, and `lastmod` is a date or a date string.",
    },
    SEO_SITEMAP_ROUTE_EXISTS: {
      why: "`seo.sitemap` serves `/sitemap.xml`, but the app has its own server route for `/sitemap.xml`.",
      fix: "Delete the server route and return its pages from `defineSitemap()` in `server/sitemap.ts`, or remove `seo.sitemap` to keep your route.",
    },
    SEO_SITEMAP_TOO_LARGE: {
      why: ({ count, limit }: { count: number, limit: number }) => `The sitemap has ${count} URLs, but one sitemap file holds at most ${limit}.`,
      fix: "Leave pages out with `seo.sitemap.exclude`, or return fewer entries from `server/sitemap.ts`.",
    },
    TASK_FAILED: {
      why: ({ detail, name }: { detail: string, name: string }) => `Task "${name}" failed: ${detail}`,
      fix: "Read the server log for the stack of the error, and fix the `run()` method of the file in `server/tasks/` that the message names.",
    },
    TASK_NOT_FOUND: {
      why: ({ name }: { name: string }) => `Task "${name}" does not exist.`,
      fix: "Run `vitehub task list` to see the registered tasks, and pass one of those names.",
    },
    TASK_NOT_IMPLEMENTED: {
      why: ({ detail }: { detail: string }) => detail,
      fix: "Export a default `defineTask()` with a `run()` method from the task file.",
    },
    TASK_RUNTIME_UNAVAILABLE: {
      why: "Nitro tasks are not enabled in this runtime.",
      fix: "Add a file to `server/tasks/` and build again. In Nuxt, use Nuxt's own task support.",
    },
    VITE_HUB_CACHE_STALE_IF_ERROR_INVALID: {
      why: ({ value }: { value: string }) => `\`staleIfError\` is the number of seconds after \`maxAge\` during which a failed call returns the stored value, but it is ${value}.`,
      fix: "Pass a number of seconds that is 0 or more, such as `staleIfError: 86400` for one day. Remove `staleIfError` to return the error at once.",
    },
    VITE_HUB_CACHE_STALE_IF_ERROR_WITH_SERIALIZE: {
      why: "`staleIfError` returns the stored value, but with `serialize` the stored value is the serialized form, and ocache would serialize it again.",
      fix: "Remove `serialize`, or remove `staleIfError` and catch the error where you call the cached function.",
    },
    VITE_HUB_CACHE_TAG_INVALID: {
      ...dynamicError,
      fix: "Pass non-empty strings to `tags` and `invalidateTag()`, for example `[\"posts\", \"post:1\"]`.",
    },
    VITE_HUB_CLOUDFLARE_EXPORT_CONFLICT: {
      why: ({ file, names }: { file: string, names: string }) => `${file} exports ${names}, but the Worker entry already has an export of that name. The default export of the entry is the app.`,
      fix: "Export each Durable Object, Workflow, or `WorkerEntrypoint` class from `server/cloudflare.ts` with a named export that no other export of the Worker uses, such as `export class Counter extends DurableObject {}`. Remove a default export.",
    },
    VITE_HUB_CLOUDFLARE_RESOURCE_MISSING: {
      why: ({ file, resources }: { file: string, resources: string }) => `${file} lacks ${resources}. ViteHub generates these resources for this build, and the Worker fails when code first reads a missing one.`,
      fix: "Check the project Wrangler config and any Nitro hook or module that edits `cloudflare.wrangler` for a step that drops or renames the entry, and remove that step. Run `vitehub inspect resources` to list the resources and their names.",
    },
    VITE_HUB_DEFINITION_PACKAGE_MISSING: {
      why: ({ definitions, packages }: { definitions: string, install: string, off: string, packages: string }) => `${definitions}, but the app does not have ${packages}.`,
      fix: ({ install, off }: { definitions: string, install: string, off: string, packages: string }) => `Run \`pnpm add ${install}\` in your app. To keep the feature off, set ${off} in the ViteHub options.`,
    },
    VITE_HUB_DEFINITION_ROOT_MISMATCH: {
      why: ({ keys, projectRoot, workingDirectory }: { keys: string, projectRoot: string, workingDirectory: string }) => `\`vitehub()\` turns features on from the Definition files of ${workingDirectory}, the project of the working directory, but the Vite root is in ${projectRoot}, which has other Definition files for ${keys}.`,
      fix: ({ keys }: { keys: string, projectRoot: string, workingDirectory: string }) => `Run Vite from the project folder, or set ${keys} to \`true\` or \`false\` in the ViteHub options.`,
    },
    VITE_HUB_DEPLOY_CHECK_INVALID: {
      why: ({ value }: { value: string }) => `A \`deploy.check\` path must be a path on the deployed site that starts with one \`/\`, such as \`/api/health\`, but it is ${value}.`,
      fix: "Write each `deploy.check` entry as a path that starts with `/`, without an origin and without spaces, such as `deploy: { check: [\"/\", \"/api/products\"] }`.",
    },
    VITE_HUB_DEPLOY_INDEX_NOW_PUBLIC_URL_MISSING: {
      why: "`deploy.indexNow` sends the URLs of the public site to IndexNow, and the build does not know that site: `publicUrl` is not a string.",
      fix: "Set `vitehub({ publicUrl: \"https://shop.example.com\" })` to the origin of the public site, or remove `deploy.indexNow`.",
    },
    VITE_HUB_DOCKERFILE_NATIVE_PACKAGES_NOT_LINUX: {
      why: ({ os, packages }: { os: string, packages: string }) => `The build ran on ${os}, so these native packages in \`.output\` hold ${os} code: ${packages}. The Linux image of \`.output/Dockerfile\` cannot load them.`,
      fix: "Install dependencies and build the app in the Linux Node image for the target CPU. Use that same base for the generated Dockerfile with `docker build --build-arg VITEHUB_NODE_IMAGE=<image>`. Or set `docker: false` in `vitehub()` and use a Dockerfile with compatible build and runtime stages.",
    },
    VITE_HUB_HEALTH_CHECK_DISABLED: {
      why: ({ check }: { check: string }) => `\`health.checks\` lists "${check}", but the app does not turn on \`${check}\` in \`vitehub()\`, so the health route has nothing to check.`,
      fix: ({ check }: { check: string }) => `Remove "${check}" from \`health.checks\`, or turn on \`${check}\` in \`vitehub()\`.`,
    },
    VITE_HUB_HEALTH_CHECK_INVALID: {
      why: ({ check }: { check: string }) => `\`health.checks\` lists ${JSON.stringify(check)}, which is not a health check name.`,
      fix: 'Use only "database", "kv", and "blob" in `health.checks`.',
    },
    VITE_HUB_HOST_PROVIDER_CONFLICT: {
      why: ({ detected, host, variable }: { detected: string, host: string, variable: string }) => `\`vitehub({ host: "${host}" })\` builds ${host} output, but \`${variable}\` is set, so this build runs on the ${detected} host, which cannot run ${host} output.`,
      fix: ({ host }: { host: string }) => `Remove \`host\` from \`vitehub()\` to build for the host that the environment names. To build ${host} output on purpose, set \`VITEHUB_HOST=${host}\`.`,
    },
    VITE_HUB_MCP_AUTH_MISSING: {
      why: "The MCP server needs Auth, so that only signed-in MCP clients call its tools.",
      fix: "Set `auth` in `vitehub()` and add `mcpOAuth()` from `vite-hub/auth/mcp` to server/auth.ts, or set `mcp: { auth: false }` to let anyone call every tool.",
    },
    VITE_HUB_PACKAGE_VERSION_UNSUPPORTED: {
      why: ({ installed }: { installed: string }) => `${installed} ViteHub packages of another release do not work with this vite-hub. The app can build and then fail at runtime, or run the code of the other release.`,
      fix: ({ install }: { install: string }) => `Install the ViteHub packages of the same release as vite-hub: \`pnpm add ${install}\`. When pnpm \`overrides\`, \`resolutions\`, or the lockfile pin a @vite-hub package, change them to the same release too, then install again.`,
    },
    VITE_HUB_PEER_VERSION_UNSUPPORTED: {
      why: ({ installed }: { installed: string }) => `${installed} ViteHub imports modules that other versions do not have, so the build fails with a resolve error, such as \`drizzle-orm/libsql/codecs\` not exported.`,
      fix: ({ install }: { install: string }) => `Install a supported version in your app: \`pnpm add ${install}\`. pnpm keeps a version that the lockfile or another dependency already has, even outside the peer range of vite-hub, and only warns. When pnpm \`overrides\` or \`resolutions\` pin the package, change them too, then install again.`,
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
      fix: "Remove `schedule.providerOutput` from `vitehub()` to run Schedules in the server process, or set `schedule: { providerOutput: false }` to start them yourself.",
    },
    VITE_HUB_R0141: {
      ...dynamicError,
      fix: "Remove `queue.driver` from `vitehub()`, or set `host: \"node\"`.",
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
      fix: "Remove `rateLimit.driver` to use the driver of the host, or use the `node` host to count in KV.",
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
      fix: "Pass an Agent name of at most 512 characters with `vitehub agent get <name>`. Use `vitehub agent list` to find the name.",
    },
    VITE_HUB_R0114: {
      ...dynamicError,
      fix: "Pass to `vitehub agent get` the name of an Agent that `vitehub agent list` shows.",
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
      fix: "Change the `agents.invoke`, `invocations.cancel`, `invocations.delete`, or `invocations.undo` call as the message says, with an Agent from `vitehub agent list` and an Invocation id from `vitehub agent invocations list`. A 409 names what the app lacks for the action, such as Realtime for undo or an invocation store that can delete.",
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
      fix: "Pass a section that `vitehub project get` lists, or a Workspace, revision, and text file under 512 KiB that `vitehub workspaces files` lists. For a 502 or 503, read the app logs for the Workspace store, Env provider, or section reader that failed, then try again.",
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
      why: ({ driver, renamed }: { driver: string, renamed?: string }) => renamed
        ? `\`cache.driver\` is ${driver}. ViteHub renamed this driver to "${renamed}", and it does not read ${driver}.`
        : `\`cache.driver\` is ${driver}. It must be "cloudflare", "deno-kv", "fs-lite", "kv", or "vercel".`,
      fix: ({ renamed }: { driver: string, renamed?: string }) => renamed
        ? `Set \`cache: { driver: "${renamed}" }\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`
        : "Set `cache.driver` to \"cloudflare\", \"deno-kv\", \"fs-lite\", \"kv\", or \"vercel\".",
    },
    VITE_HUB_R0052: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last `vitehub search query` result with the same search, or omit `cursor` to read the first page. A 409 means that the results changed after that cursor, so start again without it.",
    },
    VITE_HUB_R0053: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agent list` shows it, to `--agent` of `vitehub agent invocations capabilities`.",
    },
    VITE_HUB_R0054: {
      ...dynamicError,
      fix: "Pass an Invocation id that `vitehub agent invocations list` shows. The journal removes old Invocations after its retention limit.",
    },
    VITE_HUB_R0058: {
      ...dynamicError,
      fix: "Pass the `cursor` from the previous `invocations.list` Console RPC result without changes, or omit `cursor` to read the first page.",
    },
    VITE_HUB_R0059: {
      ...dynamicError,
      fix: "Pass at most 100 Invocation ids in the `id` list of `invocations.list`, and split a longer list into several calls.",
    },
    VITE_HUB_R0060: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agent list` shows it, to `--agent` of `vitehub agent invocations list`.",
    },
    VITE_HUB_R0061: {
      ...dynamicError,
      fix: "Pass `capability` and `triggeredBy` values of at most 512 characters to `invocations.list` (`vitehub agent invocations list`).",
    },
    VITE_HUB_R0062: {
      ...dynamicError,
      fix: "Pass a whole number of 1 or more as `limit` to `invocations.list` (`vitehub agent invocations list --limit`).",
    },
    VITE_HUB_R0063: {
      ...dynamicError,
      fix: "If you turned off the `agents` Console section, enable it. If the app has no Agent Definition, add one in `server/agents/support.ts` and set `agent` in `vitehub()` or in the `vitehub` key of `nuxt.config.ts`. To read a journal file without a server, run `vitehub agent invocations list --database .vitehub/data/agent-invocations.sqlite`.",
    },
    VITE_HUB_R0070: {
      ...dynamicError,
      fix: "Pass an Agent name of at most 512 characters, as `vitehub agent list` shows it, to `--agent` of `vitehub agent usage`.",
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
      fix: "Add server/auth.ts with the admin plugin of Better Auth, and remove `auth: false` from `vitehub()` if it is there. Or remove `console.impersonation`.",
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
      fix: "Set `driver` for the production build, such as `email: { driver: \"resend\" }` in `vitehub()`. Use `driver: \"log\"` to send no email, or build for `host: \"cloudflare\"`.",
    },
    VITE_HUB_B0009: {
      ...dynamicError,
      fix: "Remove `nitro.preset` or `vitehub.host` from nuxt.config.ts, or make them name the same host. Without `vitehub.host`, ViteHub takes the host from `nitro.preset`.",
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
      fix: "Follow the steps in the error message to run your Nuxt server with Nitro 3.",
    },
    VITE_HUB_B0024: {
      ...dynamicError,
      fix: "Remove the obsolete option from `vitehub()` or the `vitehub` options in nuxt.config.ts, and apply the migration shown in the error message.",
    },
    VITE_HUB_CONSOLE_ACCESS_HANDLER_INVALID: {
      why: "[vitehub] withConsoleAccess() requires a handler function.",
      fix: "Pass the route handler function as the first argument of `withConsoleAccess(handler, { section })`.",
    },
    VITE_HUB_CONSOLE_ACCESS_SCOPE_INVALID: {
      why: "[vitehub] withConsoleAccess() requires { section } or { anySection: true }.",
      fix: "Pass `{ section: \"<section id>\" }` or `{ anySection: true }` as the second argument of `withConsoleAccess(handler, scope)`.",
    },
    VITE_HUB_CONSOLE_ATTACHMENT_CLEANUP_QUARANTINED: {
      why: "Attachment cleanup ownership is quarantined",
      fix: "Repair the record under `_vitehub/console/quarantine/` in the Blob store as the Console guide says, then delete the quarantine object. Stored images stay unavailable until no quarantine record is left.",
    },
    VITE_HUB_CONSOLE_AUTHORIZE_FILE_MISSING: {
      why: ({ file }: { file: string }) => `[vitehub] console.authorize file does not exist: ${file}`,
      fix: "Create the file that the message names, or set `vitehub({ console: { authorize } })` to the path of an existing server file, relative to the project root.",
    },
    VITE_HUB_CONSOLE_AUTHORIZE_NOT_FUNCTION: {
      why: ({ site }: { site: "define" | "file" }) => site === "define" ? "[vitehub] defineConsoleAuthorize() requires a function." : "[vitehub] console.authorize must default-export a function.",
      fix: "Default-export `defineConsoleAuthorize(async (context) => ...)` from the `console.authorize` file, and pass it a function.",
    },
    VITE_HUB_CONSOLE_AUTHORIZE_PATH_INVALID: {
      why: "[vitehub] console.authorize must be a path to a server file.",
      fix: "Set `vitehub({ console: { authorize: \"./server/console-authorize.ts\" } })` to a non-empty path string.",
    },
    VITE_HUB_CONSOLE_AUTH_PLUGIN_MISSING: {
      why: "This page needs a Better Auth plugin that the app has not enabled.",
      fix: "Open an Auth page that the Console lists, or add the Better Auth plugin of this page to the auth configuration of the app and deploy again.",
    },
    VITE_HUB_CONSOLE_INVOCATION_FILES_LIMIT: {
      why: "Use at most ten images.",
      fix: "Attach at most ten images to one message. Send the other images in a second message.",
    },
    VITE_HUB_CONSOLE_JSON_INVALID: {
      why: ({ subject }: { subject: "The payload" | "This value" }) => `${subject} is not valid JSON.`,
      fix: "Correct the JSON in the editor. Put strings and keys in double quotes, and remove a comma after the last item of an object or array.",
    },
    VITE_HUB_CONSOLE_NUMBER_REQUIRED: {
      why: "Enter a number.",
      fix: "Enter a number in the field before you save it.",
    },
    VITE_HUB_LOGS_FILTER_UNSUPPORTED: {
      why: ({ filter }: { filter: "level" | "service" | "text" }) => `The source does not support ${filter} filters.`,
      fix: "Remove the filter that the message names from the Logs query. The log source accepts only the filters in its `info.filters`.",
    },
    VITE_HUB_LOGS_MAX_ENTRIES_INVALID: {
      why: "logs.maxEntries must be an integer from 1 to 10000.",
      fix: "Set `maxEntries` in `vitehub({ logs })` or in `createLogBuffer()` to an integer from 1 to 10000.",
    },
    VITE_HUB_LOGS_MAX_ENTRY_BYTES_INVALID: {
      why: "logs.maxEntryBytes must be an integer from 256 to 262144.",
      fix: "Set `maxEntryBytes` in `vitehub({ logs })` or in `createLogBuffer()` to an integer from 256 to 262144.",
    },
    VITE_HUB_LOGS_SOURCE_MISSING: {
      why: "[vitehub] Production Logs needs an existing source. Set logs: { source: \"./server/logs.ts\" }. The local buffer is per process and has no durable history.",
      fix: "Set `vitehub({ logs: { source: \"./server/logs.ts\" } })` to a server file that default-exports a `LogSource`, or remove `logs` from the production build.",
    },
    VITE_HUB_LOGS_SOURCE_PAGE_TOO_LARGE: {
      why: ({ limit }: { limit: "entries" | "bytes" }) => limit === "entries" ? "The source exceeded the requested page size." : "The source exceeded the response size limit.",
      fix: "Return at most `query.limit` entries from `query()` of the `LogSource`, and keep one page under 4 MB of JSON.",
    },
    VITE_HUB_REDIRECTS_FILE_RULE_SKIPPED: {
      why: ({ rules }: { rules: string }) => `Cloudflare serves static files, such as prerendered pages, before the Worker runs, so ViteHub writes \`redirect\` route rules to the \`_redirects\` file. These rules cannot go in that file: ${rules}. The Worker still redirects their paths, but not the static files on them.`,
      fix: "Write the route as a path with `:name` segments or one `/**` at the end, without an HTTP method, and use a 301, 302, 303, 307, or 308 status. Or do not prerender the paths of these rules.",
    },
    VITE_HUB_REDIRECTS_FILE_TOO_LARGE: {
      why: ({ dynamic, static: fixed }: { dynamic: number, static: number }) => `With the \`redirect\` route rules, the \`_redirects\` file has more than Cloudflare's limit of ${fixed} static or ${dynamic} dynamic redirects, so ViteHub did not add the rules. The Worker still redirects their paths, but not the static files on them.`,
      fix: "Join redirects of one section into one rule with `/**`, such as `'/blog/**': { redirect: { to: '/posts/**', status: 301 } }`, or remove old redirects from `public/_redirects`.",
    },
    VITE_HUB_REDIRECTS_HOST_INVALID: {
      why: ({ value }: { value: string }) => `\`redirects.host\` must be a host name such as \`example.com\`, but it is ${value}.`,
      fix: "Set `redirects.host` to the host name only, without `https://`, a port, or a path, for example `redirects: { host: \"example.com\", https: true }`.",
    },
    VITE_HUB_REDIRECTS_PREVIEW_HOST_INVALID: {
      why: ({ value }: { value: string }) => `Each \`redirects.previewHosts\` entry must be a host name such as \`staging.example.com\` or \`*.example.com\`, but one is ${value}.`,
      fix: "Write each preview host as a host name without `https://`, a port, or a path. Start it with `*.` to match every subdomain.",
    },
    VITE_HUB_REDIRECTS_TRAILING_SLASH_INVALID: {
      why: ({ value }: { value: string }) => `\`redirects.trailingSlash\` must be \`"add"\` or \`"remove"\`, but it is ${value}.`,
      fix: "Set `redirects.trailingSlash` to `\"remove\"` to redirect `/pricing/` to `/pricing`, or to `\"add\"` for the other way. Leave it out to keep paths as they are.",
    },
    VITE_HUB_RENAMED_PROVIDER_KEY: {
      why: ({ key, value }: { key: string, value: string }) => `\`${key}.provider\` is ${value}. ViteHub renamed this key to \`driver\`, and it does not read \`provider\`, so it would pick the driver of the host, or stop because the host has none.`,
      fix: ({ key, value }: { key: string, value: string }) => `Set \`${key}: { driver: ${value} }\` in \`vitehub()\`, or run \`npx @vite-hub/codemods driver-key\` to rename it in every config file.`,
    },
    VITE_HUB_SANDBOX_CLI_DRAIN_TIMEOUT_INVALID: {
      why: "[vitehub] --drain-timeout must be a non-negative number of milliseconds.",
      fix: "Pass `--drain-timeout` or set `VITEHUB_SANDBOX_DRAIN_TIMEOUT_MS` to a whole number of milliseconds from 0 to 2147483647.",
    },
    VITE_HUB_SANDBOX_CLI_DRIVER_INVALID: {
      why: "[vitehub] --driver must be codex or claude-code.",
      fix: "Pass `--driver codex` or `--driver claude-code` to `vitehub sandbox check`, or omit it to use codex.",
    },
    VITE_HUB_SANDBOX_CLI_OPTION_MISSING: {
      why: ({ option }: { option: string }) => `[vitehub] ${option} is required.`,
      fix: "Pass the option that the message names to the `vitehub sandbox` command, or set the environment variable that the message names. Run the command with `--help` to see every option.",
    },
    VITE_HUB_SANDBOX_CLI_PORT_INVALID: {
      why: "[vitehub] --port must be between 1 and 65535.",
      fix: "Pass `--port`, or set `CRABBOX_STATIC_PORT` or `SSH_PORT`, to a whole number from 1 to 65535.",
    },
    VITE_HUB_SANDBOX_CLI_TIMEOUT_INVALID: {
      why: "[vitehub] --timeout must be a positive number of milliseconds.",
      fix: "Pass `--timeout` to `vitehub sandbox check` as a whole number of milliseconds greater than 0, such as `--timeout 25000`.",
    },
    VITE_HUB_SANDBOX_DRIVER_HOST_UNSUPPORTED: {
      ...dynamicError,
      fix: "Use `sandboxTask: { driver: \"vercel\" }` with Vercel credentials, or use the `cloudflare` host.",
    },
    VITE_HUB_SECURITY_HEADER_INVALID: {
      why: ({ name }: { name: string }) => `\`security.headers\` sets ${name}, which is not a valid header name, or its value has a line break or a character that a header cannot hold.`,
      fix: "Use a header name such as `X-Robots-Tag`, and a value on one line. Use `false` to remove a default header.",
    },
    VITE_HUB_SECURITY_MAX_BODY_SIZE_INVALID: {
      why: ({ value }: { value: string }) => `\`security.maxBodySize\` is ${value}, which is not a size.`,
      fix: "Set `security.maxBodySize` to a whole number of bytes greater than 0, or to a size such as `\"500kb\"`, `\"1mb\"`, or `\"2gb\"`.",
    },
    VITE_HUB_SETUP_BODY_TOO_LARGE: {
      why: ({ limit }: { limit: number }) => `The request body is too large. The dev Setup endpoints accept at most ${limit} bytes.`,
      fix: "Send one Setup plan or apply request at a time, with only the fields that `vitehub add` and `vitehub remove` take.",
    },
    VITE_HUB_TEST_MODULE_NOT_LOADED: {
      why: ({ id }: { id: string }) => `The Vite server of vite-hub/test resolved "${id}", but no plugin loads it.`,
      fix: "Check that the plugin that adds this module is in `vite.config.ts` or `nuxt.config.ts`, and run the same test with Vitest. When only `vite-hub/test/register` fails, report it with the module id.",
    },
    VITE_HUB_TEST_SERVER_FAILED: {
      why: ({ error }: { error: string }) => `The Vite server of vite-hub/test failed:\n${error}`,
      fix: "Fix the error above in `vite.config.ts`, `nuxt.config.ts`, or the files that it names. `vite dev` or `nuxt dev` shows the same error.",
    },
    VITE_HUB_TEST_SERVER_TIMEOUT: {
      why: "The Vite server of vite-hub/test did not start in 60 seconds.",
      fix: ({ directory }: { directory: string }) => `Delete ${directory} and run the tests again. To see the server error, run one test file with \`node --import vite-hub/test/register --test-isolation=none <file>\`.`,
    },
    VITE_HUB_UNKNOWN_OPTION: {
      why: ({ key, where }: { key: string, suggestion: string, where: string }) => `\`${key}\` in ${where} is not a ViteHub option. ViteHub would ignore it, and the feature that it names would stay off.`,
      fix: ({ key, suggestion }: { key: string, suggestion: string, where: string }) => suggestion ? `Rename \`${key}\` to \`${suggestion}\`.` : `Remove \`${key}\`, or use an option from https://vitehub.dev/docs/reference/config-options.`,
    },
  },
})
