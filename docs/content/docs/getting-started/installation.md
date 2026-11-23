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

- Node.js 24.15 or newer. Nuxt 5 does not install on Node.js 25, so for Nuxt use 24.15 or newer on 24.x, or 26 or newer.
- pnpm. The examples use pnpm. Use pnpm 11.5 or newer for the Nuxt 5 nightly alias. Older versions can hang when they resolve it.
- For Nuxt: a Nuxt 5 app on Nitro 3. Nuxt 5 is only in nightly builds for now: `pnpm add nuxt@npm:nuxt-nightly@5x`.
- For Nitro: a Nitro 3 app with `nitro()` in `vite.config.ts`.

## Set up the app

Pick your framework. The docs remember it and show its code on every page. Nitro is the server that runs your API routes. Nuxt includes it, and `vitehub()` adds it to a Vite app.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
In your Nuxt 5 app, install ViteHub, H3, and Valibot for request validation. The tutorials import H3 helpers explicitly.

```bash pm [commands/install-nuxt]
pnpm add vite-hub h3@^2.0.8 valibot
```

Add `vite-hub/nuxt` to `nuxt.config.ts` and put its options under `vitehub`. Keep your other options.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {},
})
```

ViteHub detects the host when the build runs on Cloudflare Workers Builds, Vercel, Netlify, or Deno Deploy. Elsewhere, such as on your computer, it builds for Node. See [Choose a host](/docs/frameworks-hosts#choose-a-host).

Keep Nuxt's `tsconfig.json` so the module can add ViteHub's types. See the [Nuxt guide](/docs/frameworks-hosts/nuxt) for more options.
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
  plugins: [vitehub(), nitro()],
})
```

ViteHub detects the host when the build runs on Cloudflare Workers Builds, Vercel, Netlify, or Deno Deploy. Elsewhere, such as on your computer, it builds for Node. See [Choose a host](/docs/frameworks-hosts#choose-a-host).

The tutorials use port 3000, so set the `dev` script in `package.json` to `vite --port 3000 --strictPort`. Add `vite-hub/tsconfig` to `extends` in `tsconfig.json`, then generate the types once:

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

Create `package.json`. In an existing app, set `"type": "module"` and add the scripts:

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

Install ViteHub with its Nitro and H3 versions, Valibot for request validation in the route examples, plus Vite and TypeScript. `nitro` is a peer of `vite-hub`, so ViteHub runs on your app's Nitro. It supports `3.0.261102-rc` and `^3.0.261103-rc`.

```bash pm [commands/install-vite]
pnpm add vite-hub nitro@3.0.261102-rc h3@2.0.8 valibot
pnpm add -D vite@^8 typescript@^6 @types/node@^24
```

Add `vitehub()` to `vite.config.ts`. It includes the Nitro plugin, so do not add `nitro()` yourself. Keep your other plugins.

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub()],
})
```

ViteHub detects the host when the build runs on Cloudflare Workers Builds, Vercel, Netlify, or Deno Deploy. Elsewhere, such as on your computer, it builds for Node. See [Choose a host](/docs/frameworks-hosts#choose-a-host).

Create `tsconfig.json`, or add `vite-hub/tsconfig` to `extends` in yours so your editor gets the types for enabled features:

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

Generate the initial types:

```bash [commands/prepare-types]
pnpm vitehub types prepare
```

If your `tsconfig.json` sets `files`, add `.vitehub/types.d.ts` to that list. Your `files` list replaces the one inherited from `vite-hub/tsconfig`, so without it the editor does not see the ViteHub types.

Add `"postinstall": "vitehub types prepare"` to `scripts` to run this after each install. `vite dev` and `vite build` also refresh the types.
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

Your server works. On Vite, `/` returns `404` until you add a page, which is expected.

## Add your first feature

Every feature stays off until you enable it in your ViteHub config, such as `kv: true`. Next, try:

- [First Server Primitive](/docs/getting-started/first-server-primitive): save a setting and read it back.
- [First Agent](/docs/getting-started/first-agent): run an Agent that answers without a model account.

## Add feature packages

Every feature except Env, Source, and Logs lives in its own package. If you enable a feature and its package is missing, the build stops and prints one install command for every package the feature needs, including packages already brought in by another dependency:

```text [output/missing-package.txt]
[vitehub] The agent feature needs @vite-hub/agent. The workflow feature needs @vite-hub/workflow. Install them in your app with: pnpm add @vite-hub/agent @vite-hub/workflow
```

If an installed `@vite-hub/*` package version does not match `vite-hub`, the build stops with [`VITE_HUB_PACKAGE_VERSION_UNSUPPORTED`](/docs/development/diagnostics/vite_hub_package_version_unsupported). Keep all ViteHub packages on the same release, and change pnpm `overrides` that pin them too.

If `drizzle-orm` is outside the range of `vite-hub`, such as Drizzle 0.x, the Database feature and builds that load the Drizzle query adapter for Agent Invocations stop with [`VITE_HUB_PEER_VERSION_UNSUPPORTED`](/docs/development/diagnostics/vite_hub_peer_version_unsupported). Agent builds that do not load the adapter can keep an unrelated Drizzle version. pnpm can keep a version that the lockfile or another dependency already has, such as the 0.44 that `@nuxt/ui` brings in, and only warn. If the build needs Drizzle, add a supported version to your app:

```text [output/unsupported-drizzle.txt]
[VITE_HUB_PEER_VERSION_UNSUPPORTED] drizzle-orm 0.44.7 is installed, but vite-hub 0.3.1 supports drizzle-orm@1.0.0-rc.5 || ^1.0.0. ViteHub imports modules that other versions do not have, so the build fails with a resolve error, such as `drizzle-orm/libsql/codecs` not exported.
```

If another third-party dependency version falls outside the range supported by your `vite-hub` release, the build continues and prints a warning with the supported range and install command:

```text [output/unsupported-package.txt]
[vitehub] @libsql/client 0.14.0 is installed, but vite-hub 0.3.1 supports @libsql/client@^0.18.0. Other versions can fail at runtime with errors that do not name the version. Update vite-hub to a release that supports these versions, or install supported versions in your app with: pnpm add '@libsql/client@^0.18.0'
```

::details{summary="Which features need their own package?"}
`vite-hub` includes Env, Source, Logs, and the Console endpoint. Every other feature has its own package, so your app installs and loads only the features that it uses. Add the packages below before you turn on a feature. This is the same for Nuxt, Nitro, and Vite.

| Feature | Add these packages |
| --- | --- |
| `agent` | `@vite-hub/agent` |
| `auth` | `@vite-hub/auth better-auth drizzle-orm` |
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
| `server/content.ts` | `@vite-hub/content`, and `@vite-hub/cms` for the `cms` preset. Content uses the app's `comark`, `@comark/html`, and `comark-ui`, which pnpm and npm install with it |
| `server/comments.ts` | `@vite-hub/comments` |
| `.template.md` imports | `@vite-hub/markdown-template` |
| Console with Agents | `@libsql/client drizzle-orm` |
| Console MCP client (`console.mcpClient`) | `@modelcontextprotocol/sdk` |
| `vite-hub/choices` | `@vite-hub/choices` |
| `vite-hub/forge` | `@vite-hub/forge` |
| `vite-hub/gateways` | `@vite-hub/gateways` |
| `vite-hub/ui` | `@vite-hub/ui` |
| `vite-hub/console/ui` | `@vite-hub/ui @json-render/core @json-render/vue @vueuse/core` |
| `vite-hub/docs/*` | `@vite-hub/docs` |
| `vite-hub/presets/*` | `@vite-hub/presets` |

Env is on by default. If the host cannot run a feature you turned on, the build fails. See [Frameworks and hosts](/docs/frameworks-hosts).

Some hosts and providers add an SDK, and the build names it in the same error. On Vercel, [Workflow](/docs/workflows/hosts) needs `@vercel/functions`, and Queue needs `@vercel/queue` and `@vercel/functions`. A Sandbox Task needs `@vercel/sandbox` on Vercel or `@cloudflare/sandbox` on Cloudflare, and also `typescript`. `queue: { driver: "postgres" }` needs `postgres`. A [native Vercel Workflow](/docs/workflows/configure#add-a-durable-vercel-entry), such as a Workflow folder, also needs `workflow` and `@workflow/builders`. When they are missing, the build stops with `WORKFLOW_R0006` and prints the install command.
::

## Update ViteHub

Upgrade `vite-hub` and every `@vite-hub/*` package to the latest release together:

```bash [commands/update]
pnpm vitehub update
```

This updates the version in every `package.json` of the workspace, in `overrides` and `catalog` of `pnpm-workspace.yaml`, and in npm, Yarn, and Bun overrides. Then it installs. With pnpm, it also adds `vite-hub` and `@vite-hub/*` to `minimumReleaseAgeExclude`, so a new ViteHub release installs on the day it is published. It also removes old ViteHub versions from that list.

To try a [pkg.pr.new](https://pkg.pr.new) preview, pass its commit:

```bash [commands/update-preview]
pnpm vitehub update --preview 01898b8
```

Each ViteHub package then points at `https://pkg.pr.new/vite-hub/vitehub/<package>@<commit>`. With pnpm, the command also sets `blockExoticSubdeps: false`, because preview packages depend on each other by URL. Run `pnpm vitehub update` again to go back to the npm release.

`--dry-run` previews changes without writing files. `--no-install` updates the files and prints the install command.

::details{summary="Why does pnpm run `pnpm update` and not `pnpm install`?"}
A preview also accepts the npm release of each ViteHub package that it uses, so `pnpm install` can keep the npm packages from `pnpm-lock.yaml` next to the preview. `pnpm update vite-hub "@vite-hub/*"` resolves them again and keeps the URLs. To check, run `pnpm why @vite-hub/env`. With a stale lockfile, it lists two versions:

```text [output/pnpm-why-stale.txt]
@vite-hub/env@0.0.0-preview-156a885
@vite-hub/env@0.1.0 peer#1f85 (2 variations)
```

After `vitehub update`, it lists only the preview.
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

To build a library or wire the server yourself, install individual `@vite-hub/*` packages. For example, `@vite-hub/kv` exports `hubKV()` from `@vite-hub/kv/vite`. You then own the server entry and host setup. The tutorials do not use this path. Read the package README for it.

This install is smaller. For a Blob and Queue app with Nitro, H3, and Vite, using pnpm 12 on Linux:

| Install | Packages | `node_modules/.pnpm` |
| --- | --- | --- |
| `vite-hub` | 186 | 171 MB |
| `@vite-hub/blob @vite-hub/queue @vite-hub/env` | 87 | 80 MB |

`vite-hub` adds the CLI, the Console, `vitehub()` with its hosts, and its built-in features.

## Model and coding providers

Install a provider package only when you use it. Model Drivers need `ai` and the credentials in [Agent Drivers](/docs/agents/agent-drivers). The built-in coding Drivers use `@openai/codex@0.169.0` or `@anthropic-ai/claude-agent-sdk@0.3.321`. ViteHub bundles their runtime, so pnpm settings do not change.

A Node.js build copies native coding-provider packages for the OS, CPU, and Linux libc of the build machine. Build on the same type of machine that you deploy to.
