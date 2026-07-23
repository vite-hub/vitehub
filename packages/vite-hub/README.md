# vite-hub

`vite-hub` is the cohesive ViteHub framework distribution. It gives applications one ViteHub dependency, one `vitehub()` Vite entry, and deliberate feature subpaths while every `@vite-hub/*` package keeps owning its implementation and remains independently installable.

## Install

```sh
pnpm add vite-hub
```

## Configure ViteHub

Choose one built-in deployment preset. Application routes and feature imports stay unchanged when the target changes.

```ts
// vite.config.ts
import { vitehub } from "vite-hub"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
})
```

The public presets are `cloudflare`, `netlify`, `vercel`, `deno`, and `node`. Each resolves once to a host, runtime, Nitro output, packaging policy, and service adapters; do not also set `nitro.preset`, `NITRO_PRESET`, `SERVER_PRESET`, or `VITEHUB_HOSTING`.

ViteHub derives one deployment identity from the nearest `package.json` name, falling back to the Vite root directory name. Set `name` to pin the identity explicitly. `VITEHUB_DEPLOYMENT_NAME` remains a compatibility input, and conflicts with an explicit `name` fail configuration. Cloudflare uses this identity for the default Worker, Blob bucket, Queue prefix, Rate Limit namespace, and Sandbox name; explicit Worker, Blob bucket, driver, and store options still win.

Blob, Agent, Auth, Database, Email, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace are opt-in:

```ts
vitehub({
  agent: true,
  blob: true,
  preset: "cloudflare",
  auth: true,
  database: true,
  email: true,
  kv: true,
  queue: true,
  rateLimit: true,
  sandbox: true,
  schedule: true,
  workflow: true,
  workspace: true,
})
```

| Preset | Blob | Queue | Rate Limit | Sandbox | Schedule |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | R2 | Cloudflare Queues | Cloudflare | Cloudflare Containers | Supported |
| `netlify` | Netlify Blobs | Unsupported | Unsupported | Unsupported | Supported |
| `vercel` | Vercel Blob | Vercel Queues | Unsupported | Vercel Sandbox | Supported |
| `deno` | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported |
| `node` | Local filesystem (single host) | Unsupported | Process memory (single process) | Unsupported | Supported |

Selecting an unsupported opt-in capability fails the build with the preset policy. You can instead configure an explicit Blob driver through `blob` or compose an owner package directly when the application provides its own portable implementation.

The Deno preset uses Nitro's Deno entrypoint, so it rejects Schedule and `agent.runtime: "deno"`; those owner-package outputs require an explicit deployment integration.

The Deno preset emits `.output/deno.json`, stages emitted runtime packages and installed optional native dependencies under `.output/node_modules`, and writes `.output/deploy.mjs`, a non-interactive create-or-update runner used by the `node ./deploy.mjs` command in `.output/nitro.json`; set `DENO_DEPLOY_ORG` plus `DENO_DEPLOY_APP` or `VITEHUB_DEPLOYMENT_NAME` before deployment. The runner uploads node modules when it creates or updates an app. The Node preset emits a plain Node server artifact suitable for a VPS or container image; Docker is not a hosting preset.

## Configure TypeScript

Extend `vite-hub/tsconfig` to load ViteHub's generated declarations without adding `.vitehub` to your application `include`. This config requires TypeScript 5.5 or newer.

```json
{
  "extends": ["vite-hub/tsconfig"],
  "include": ["server/**/*.ts", "vite.config.ts"]
}
```

Run `vitehub types prepare` after installation so editors have `.vitehub/types.d.ts` before the first dev build:

```json
{
  "scripts": {
    "postinstall": "vitehub types prepare"
  }
}
```

Vite config resolution and builds also refresh the entry. Defining `files` in the application config replaces the inherited entry, so include `.vitehub/types.d.ts` there when taking ownership of `files`.

## Use feature APIs

```ts
import { defineAgent } from "vite-hub/agent"
import { workspaceShell } from "vite-hub/agent/capabilities"
import { codexDriver } from "vite-hub/agent/harness/codex"
import { env } from "vite-hub/env"
import { renderMarkdownTemplate } from "vite-hub/markdown-template"
import { defineWorkspace } from "vite-hub/workspace"
import { defineWorkflow } from "vite-hub/workflow"
```

The root export intentionally contains only the framework configuration API. Feature code belongs on a feature subpath, which forwards to the package that owns it.

ViteHub-owned adapters use `vite-hub/*` even when they integrate an optional third-party package. Install the external provider or SDK explicitly, such as `@ai-sdk/harness-codex` for `vite-hub/agent/harness/codex`; applications should not need a second `@vite-hub/*` dependency to reach the adapter.

Install an `@vite-hub/*` owner package directly when building a custom composition, another framework integration, or package-level tooling.
