---
title: Installation
navigation.title: Installation
description: Set up a Nuxt, Nitro, or Vite app with ViteHub and check that it serves a route.
navigation.order: 2
navigation.group: Get started
icon: i-lucide-download
---

Set up an app with ViteHub and check that it answers a request. Every later tutorial starts from this app. You need no account.

## Prerequisites

- Node.js 22.22 or newer on 22.x, 24.11 or newer on 24.x, or 26 or newer. Node.js 23, Node.js 24 before 24.11, and Node.js 25 are not supported.
- pnpm. The examples use pnpm. Use pnpm 11.5 or newer for the Nuxt 5 nightly alias; older versions can hang when they resolve it.
- For Nuxt: an app on Nuxt 5, which uses Nitro 3. Nuxt 5 is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`.
- For Nitro: a Nitro 3 app that adds `nitro()` in `vite.config.ts`.

::details{summary="Why Node.js 22.22?"}
ViteHub uses Nitro, which needs Node.js 22.22. A package installed alone, without `vite-hub`, can need less: Queue needs 22.19, and most others 22.18.

On Node.js 22, features that open a local SQLite file (a `file:` Database and Comments) print one harmless `ExperimentalWarning` for `node:sqlite`. Node.js 24 does not print it.
::

## Set up the app

Pick your framework. The docs remember it and show its code on every page. Nitro is the server that runs your API routes. Nuxt includes it, and `vitehub()` adds it to a Vite app.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
In your Nuxt 5 app, install ViteHub, H3, and Valibot for request validation. The tutorials import H3 helpers explicitly.

```bash pm [commands/install-nuxt]
pnpm add vite-hub h3@^2.0.8 valibot
```

> [!NOTE] If pnpm stops with ERR_PNPM_IGNORED_BUILDS
> The packages from that command are installed, but pnpm did not run the install script of `esbuild`. pnpm runs the install script of a package only after you allow it. ViteHub uses esbuild to bundle server code. Allow it one time:
>
> ```bash [commands/approve-esbuild-nuxt]
> pnpm approve-builds esbuild
> ```

Add the module to `nuxt.config.ts` and put its options under `vitehub`. Keep your other options.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: { preset: "node" },
})
```

`preset` tells ViteHub where the app runs. `node`, a Node.js server, fits your computer. Other presets are `cloudflare`, `vercel`, `netlify`, and `deno`.

Keep Nuxt's `tsconfig.json`; the module adds the ViteHub types to it. The [Nuxt guide](/docs/frameworks-hosts/nuxt) has more options.
:::

:::tabs-item{label="Nitro"}
In your Nitro app, install ViteHub, its H3 version, and Valibot for request validation:

```bash pm [commands/install-nitro]
pnpm add vite-hub h3@^2.0.8 valibot
```

Add `vitehub()` to `vite.config.ts` before `nitro()`, so ViteHub uses your Nitro plugin. Keep your other plugins.

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { nitro } from "nitro/vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ preset: "node" }), nitro()],
})
```

`preset` tells ViteHub where the app runs. `node`, a Node.js server, fits your computer. Other presets are `cloudflare`, `vercel`, `netlify`, and `deno`.

The tutorials use port 3000, so set the `dev` script in `package.json` to `vite --port 3000 --strictPort`. Add `vite-hub/tsconfig` to `extends` in your `tsconfig.json`, then write the types once:

```bash [commands/prepare-types]
pnpm vitehub types prepare
```
:::

:::tabs-item{label="Vite"}
Create a folder for the app:

```bash [commands/create-vite-app]
mkdir vitehub-app
cd vitehub-app
```

Create `package.json`. In an existing app, set `"type": "module"` and add the scripts.

```json [package.json]
{
  "name": "vitehub-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 3000 --strictPort",
    "build": "vite build",
    "start": "node .output/server/index.mjs"
  }
}
```

Install ViteHub with its Nitro and H3 versions, Valibot for request validation in the route examples, plus Vite and TypeScript.
`nitro` is a peer of `vite-hub`, so ViteHub runs on your app's Nitro. It supports
`3.0.261102-rc` and `^3.0.261103-rc`.

```bash pm [commands/install-vite]
pnpm add vite-hub nitro@3.0.261102-rc h3@2.0.8 valibot
pnpm add -D vite@^8 typescript@^6 @types/node@^24
```

> [!NOTE] If pnpm stops with ERR_PNPM_IGNORED_BUILDS
> The packages from that command are installed, but pnpm did not run the install script of `esbuild`. pnpm runs the install script of a package only after you allow it. ViteHub uses esbuild to bundle server code. Allow it one time:
>
> ```bash [commands/approve-esbuild]
> pnpm approve-builds esbuild
> ```
>
> Then run `pnpm add -D vite@^8 typescript@^6 @types/node@^24` before you continue.

Add `vitehub()` to `vite.config.ts`. It includes the Nitro plugin, so do not add Nitro yourself. Keep your other plugins.

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
})
```

`preset` tells ViteHub where the app runs. `node`, a Node.js server, fits your computer. Other presets are `cloudflare`, `vercel`, `netlify`, and `deno`.

Create `tsconfig.json`, or add `vite-hub/tsconfig` to `extends` in yours. This gives your editor the types of the features you turn on.

```json [tsconfig.json]
{
  "extends": ["vite-hub/tsconfig"],
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "vite.config.ts"]
}
```

Write the types once:

```bash [commands/prepare-types]
pnpm vitehub types prepare
```

If your `tsconfig.json` sets `files`, add `.vitehub/types.d.ts` to that list. Your `files` list replaces the one from `vite-hub/tsconfig`, so without it the editor does not see the ViteHub types.

To repeat this after each install, add `"postinstall": "vitehub types prepare"` to the scripts. `vite dev` and `vite build` also update the types.
:::
::

## Check that it works

Create `server/api/health.get.ts`. The file path sets the route: `GET /api/health`.

```ts [server/api/health.get.ts]
import { defineEventHandler } from "h3"

export default defineEventHandler(() => ({ ok: true }))
```

Start the dev server:

```bash [commands/dev]
pnpm dev
```

In a second terminal, send a request:

```bash [commands/check]
curl http://localhost:3000/api/health
```

You get:

```json [output/health.json]
{"ok":true}
```

The app works. On Vite, `/` returns `404` until you add a page. That is expected.

## Add your first feature

Each feature is off until you turn it on in the ViteHub options, for example `kv: true`. Continue with:

- [First Server Primitive](/docs/getting-started/first-server-primitive): save a setting and read it back.
- [First Agent](/docs/getting-started/first-agent): run an Agent that answers without a model account.

## Add feature packages

Each feature other than Env, Source, and Logs needs its own package. When you turn on a feature and its package is missing, the build stops and prints the install command:

```text [output/missing-package.txt]
[vitehub] The agent feature needs @vite-hub/agent. The workflow feature needs @vite-hub/workflow. Install the missing packages in your app with: pnpm add @vite-hub/agent @vite-hub/workflow
```

When an installed package has a version that your `vite-hub` release does not support, the build continues and prints a warning with the supported range and the install command:

```text [output/unsupported-package.txt]
[vitehub] drizzle-orm 0.44.7 is installed, but vite-hub 0.1.0 supports drizzle-orm@^0.45.3. Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add 'drizzle-orm@^0.45.3'
```

::details{summary="Which features need their own package?"}
`vite-hub` includes Env, Source, Logs, and the Console endpoint. Every other feature has its own package, so your app installs and loads only the features that it uses. Add the packages below before you turn on a feature. This is the same for Nuxt, Nitro, and Vite.

| Feature | Add these packages |
| --- | --- |
| `agent` | `@vite-hub/agent @vite-hub/workflow` (Agents run on Workflow) |
| `auth` | `@vite-hub/auth better-auth` |
| `blob` | `@vite-hub/blob` |
| `browser` | `@vite-hub/browser` |
| `channels` | `@vite-hub/channels` |
| `connections` | `@vite-hub/connections @vite-hub/database drizzle-orm` |
| `database`, and Connections or Comments, which turn Database on | `@vite-hub/database drizzle-orm`, and `drizzle-kit` as a development dependency |
| `email` | `@vite-hub/email` |
| `i18n` | `@vite-hub/i18n` |
| `kv`, and `cache: { driver: "kv" }` | `@vite-hub/kv` |
| `queue` | `@vite-hub/queue` |
| `rateLimit` | `@vite-hub/rate-limit` |
| `realtime` | `@vite-hub/realtime` |
| `sandboxTask` | `@vite-hub/sandbox` |
| `schedule` | `@vite-hub/schedule` |
| `workflow` | `@vite-hub/workflow` |
| `workspace` | `@vite-hub/workspace`, and `@vite-hub/shell` for shell commands |
| `server/content.ts` | `@vite-hub/content`, and `@vite-hub/cms` for the `cms` preset |
| `server/comments.ts` | `@vite-hub/comments` |
| `.template.md` imports | `@vite-hub/markdown-template` |
| Console with Agents | `@libsql/client drizzle-orm` |
| Console MCP client (`console.mcpClient`) | `@modelcontextprotocol/sdk` |
| `vite-hub/decisions` | `@vite-hub/decisions` |
| `vite-hub/forge` | `@vite-hub/forge` |
| `vite-hub/gateways` | `@vite-hub/gateways` |
| `vite-hub/ui` | `@vite-hub/ui` |
| `vite-hub/console/ui` | `@vite-hub/ui @json-render/core @json-render/vue @vueuse/core` |
| `vite-hub/docs/*` | `@vite-hub/docs` |
| `vite-hub/presets/*` | `@vite-hub/presets` |

Agent also turns on Workflow, unless you set `workflow: false`. Env is on by default. If the preset cannot run a feature you turned on, the build fails. See [Frameworks and hosts](/docs/frameworks-hosts).

Each provider's guide lists its SDKs. [Vercel Workflow](/docs/workflows/hosts) needs `@vercel/functions` for all definitions; add `workflow` and `@workflow/builders` for native durable definitions. A Sandbox Task needs `typescript` and its provider's SDK.
::

## Build for production

Stop the dev server, then build and start the app:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```bash [commands/build-nuxt]
pnpm build
node .output/server/index.mjs
```
:::

:::tabs-item{label="Nitro"}
```bash [commands/build-nitro]
pnpm build
node .output/server/index.mjs
```
:::

:::tabs-item{label="Vite"}
```bash [commands/build]
pnpm build
pnpm start
```
:::
::

The server uses port `3000`. Send the health request again to check it.

Do not commit `.vitehub`, `.output`, `.nuxt`, `node_modules`, or `.env`. Local data is in `.vitehub/data`. To keep it across deploys, put it on persistent storage.

## Install one package without `vite-hub`

To build a library or wire the server yourself, install one `@vite-hub/*` package. For example, `@vite-hub/kv` gives `hubKV()` from `@vite-hub/kv/vite`. You then own the server entry and host setup. The tutorials do not use this path; read the package README.

This install is smaller. For a Blob and Queue app with Nitro, H3, and Vite, using pnpm 12 on Linux:

| Install | Packages | `node_modules/.pnpm` |
| --- | --- | --- |
| `vite-hub` | 186 | 171 MB |
| `@vite-hub/blob @vite-hub/queue @vite-hub/env` | 87 | 80 MB |

`vite-hub` adds the CLI, the Console, `vitehub()` with its presets, and its included features.

## Model and coding providers

Install a provider package only when you use it. Model Drivers need `ai` and the credentials in [Agent Drivers](/docs/agents/agent-drivers). The built-in coding Drivers use `@openai/codex@0.149.1` or `@anthropic-ai/claude-agent-sdk@0.3.246`. ViteHub bundles their runtime, so pnpm settings do not change.

A Node.js build copies the native coding-provider packages for the build computer's OS, CPU, and Linux libc. Build on the same type of computer you deploy to.
