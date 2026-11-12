---
title: Vite integrations and Provider Output
navigation.title: Vite integrations and Provider Output
description: Learn how ViteHub wires a package into Vite and what it builds for your host.
navigation.order: 33.2
navigation.group: Build state
icon: i-lucide-plug
---

A Vite integration plugs a package into Vite dev and builds. Provider Output is what it generates for a host: routes, functions, bindings, workers, crons, or runtime files.

Your app code uses the package's documented server API, not generated internals.

## Configure the integration

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', agent: true, kv: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', agent: true, kv: true }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', agent: true, kv: true }),
  ],
})
```
:::
::

Options that affect discovery, generated files, provider bindings, or deployment go in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`. Options for one named item go in its Definition.

## Use Provider Output as build evidence

Inspect the output to check routes, bindings, or host wiring. Import it only when the package documents a path such as `#vitehub/env/server`.

| Need | Surface |
| --- | --- |
| Development and build wiring | The package Vite integration. |
| One named declaration | A Definition file. |
| Host deployment files | Provider Output from the integration. |
| Server code access | A documented package or generated import. |

Read [Definition discovery](/docs/development/definition-discovery), [Runtime Helpers and stable imports](/docs/reference/runtime-helpers), and [Provider Output](/docs/reference/provider-output) for details.

## Persistent Node storage

Set `dataDir` in the ViteHub options to pick one local storage directory on a Node host:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: "node",
    dataDir: "/var/lib/app",
    agent: true,
    console: { authorize: "./server/console-authorize.ts" },
    kv: true,
    blob: true,
    workspace: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      dataDir: "/var/lib/app",
      agent: true,
      console: { authorize: "./server/console-authorize.ts" },
      kv: true,
      blob: true,
      workspace: true,
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      dataDir: "/var/lib/app",
      agent: true,
      console: { authorize: "./server/console-authorize.ts" },
      kv: true,
      blob: true,
      workspace: true,
    }),
  ],
})
```
:::
::

Turned-on integrations use `agent-state.sqlite`, `agent-invocations.sqlite`, `kv/`, `blob/`, and `workspaces/` in this directory. Named local KV and Blob stores get their own subdirectories. Explicit paths and remote providers win, and disabled services stay off. Relative paths resolve from the working directory of the configuration process.

::warning
The host must give a persistent, writable filesystem at this path. The option does not create a volume or make a temporary filesystem durable. Other hosts reject it. For hosted storage, keep your provider configuration.
::

To keep an existing storage location, use `agent.providers.state.url`, `agent.invocations.databaseUrl`, or each store's path option. Runtime database URL overrides still win. Changing the directory does not move stored data.

## Public URL

Set `publicUrl` in the ViteHub options to your deployed app's public origin. ViteHub uses it for Console invocation links, GitHub activity links, Chat error links, trigger `failed` events, telemetry `session_url` values, the default Auth `baseURL`, and the Connections OAuth callback and origin check:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: "node",
    publicUrl: "https://agents.example.com",
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      publicUrl: "https://agents.example.com",
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      publicUrl: "https://agents.example.com",
    }),
  ],
})
```
:::
::

Use a function when one build serves Agents from different origins. ViteHub calls it once per Agent at build time, with the name from its file. An explicit definition name gets the same origin at runtime. A shared definition found under several names gets no implicit alias:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: "node",
    publicUrl: agent => agent === "bot" ? "https://agent.example.com" : "https://agent-dev.example.com",
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      publicUrl: agent => agent === "bot" ? "https://agent.example.com" : "https://agent-dev.example.com",
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      publicUrl: agent => agent === "bot" ? "https://agent.example.com" : "https://agent-dev.example.com",
    }),
  ],
})
```
:::
::

Standalone provider bundles get the origin and app base from their own build configuration. Concurrent builds do not share URL constants.

- It must be an `http(s)` origin without a path. ViteHub adds the app base path.
- It applies to `vite build` only. In `vite dev`, Console links and Auth inside a request use the request origin.
- GitHub activity and evlog session links have no request-origin fallback. In development, set `activity.publicUrl` on the GitHub Channel or the evlog `sessionUrl` callback.
- Without `publicUrl`, links and Auth inside a request use the request origin. Links made outside a request are left out.
- With the function form, Auth and Connections use the configured origin whose host matches the request host.

### Read the public URL in server code

`resolvePublicUrl()` from `vite-hub/runtime` returns the origin, or `undefined` when `publicUrl` is unset or in `vite dev`. It needs no request, so a Workflow step, a Schedule, or a Channel reply can build absolute links:

```ts
import { resolvePublicUrl } from "vite-hub/runtime"

const dashboardUrl = new URL("/dashboard", resolvePublicUrl() ?? "http://localhost:3000").href
```

With the function form, pass the Agent name: `resolvePublicUrl({ agentName: "bot" })`. In a request handler, pass `{ request }` to fall back to the request origin.

### Register webhooks at the public URL

When `publicUrl` is a string, `vitehub channels sync` and `vitehub channels history` use it as the default `--url`. A `--url` flag still wins. `channels sync --apply` needs `--confirm-origin` only for a `--url` you type. See [Synchronize Channel webhooks](/docs/development/cli#synchronize-channel-webhooks).

### Serve a Cloudflare Worker on its custom domain

On the `cloudflare` host, a string `publicUrl` with an HTTPS DNS hostname outside `workers.dev` and no port also writes the custom domain into the generated `wrangler.json`. IP addresses, `localhost`, and invalid hostnames leave routing alone:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: "cloudflare",
    publicUrl: process.env.APP_URL, // https://calories.example.com
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "cloudflare",
      publicUrl: process.env.APP_URL, // https://calories.example.com
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: "cloudflare",
      publicUrl: process.env.APP_URL, // https://calories.example.com
    }),
  ],
})
```
:::
::

```json [.output/server/wrangler.json]
{
  "routes": [{ "pattern": "calories.example.com", "custom_domain": true }],
  "workers_dev": false
}
```

ViteHub leaves routing to you when `nitro.cloudflare.wrangler` or the project `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` sets `route`, `routes`, or `workers_dev`. Nitro merges these keys from both places, so keep all routing in one place. Without `publicUrl`, or with a `workers.dev` origin, the Worker keeps its `workers.dev` host.


Use `agent.providers.state.url`, `agent.invocations.databaseUrl`, or each store's path option to preserve an existing location. Existing runtime database URL overrides still take precedence. Changing the directory does not migrate stored data.
