# vite-hub

`vite-hub` is the ViteHub application distribution. It registers enabled integrations through one `vitehub()` call and exposes application APIs on explicit `vite-hub/*` feature imports.

Use it for a Vite or Nuxt application that needs Server Primitives, Agents, or both. Install an `@vite-hub/*` owner package directly when you are building a library, another framework integration, or a custom package composition.

## Install

```sh
pnpm add vite-hub
```

You need Node.js 24.15 or newer, Vite 8 or newer, and an ESM package with `"type": "module"` or a `vite.config.mts` file. Hosted primitives and model providers can also require credentials, network access, and billed accounts. Their feature guides list those requirements before the first provider call.

## Configure ViteHub

Choose one built-in deployment preset. Application routes and feature imports stay unchanged when the target changes.

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
});
```

This registers ViteHub's build integration. Your application still needs a server entry or a framework such as Nuxt. For Nuxt, use the `vite-hub/nuxt` module shown in the [installation guide](https://vitehub.dev/docs/getting-started/installation).

## Run a complete first result

Choose the result that matches the application you are building:

- [First Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive) builds and starts a local Node server, writes and reads a KV value, and returns `{"settings":{"theme":"system"}}` from `curl`.
- [First Agent](https://vitehub.dev/docs/getting-started/first-agent) builds and starts a local Node server, runs an offline Agent Invocation, and returns `{"text":"Hello, Ada. This result came from an Agent Invocation."}`.

Both guides use `vite-hub`, include complete files and commands, and need no provider credentials. Do not treat the configuration fragment above as a successful runtime check by itself.

The public presets are `cloudflare`, `netlify`, `vercel`, `deno`, and `node`. Each resolves once to a host, runtime, Nitro output, packaging policy, and service adapters; do not also set `nitro.preset`, `NITRO_PRESET`, `SERVER_PRESET`, or `VITEHUB_HOSTING`.

ViteHub derives one deployment identity from the nearest `package.json` name, falling back to the Vite root directory name. Set `name` to pin the identity explicitly. Cloudflare Workers Builds supplies its connected Worker through `WRANGLER_CI_OVERRIDE_NAME`; the Cloudflare preset uses it after explicit `name` and fails when the two resolve to different values because the connected Worker remains the deployment target. Cloudflare uses the resolved identity for the default Worker, Blob bucket, Queue prefix, Rate Limit namespace, Sandbox, and Container names. Explicit Wrangler Worker names remain authoritative outside Workers Builds, while explicit Blob bucket, driver, and store options still win. The Workers Builds fallback derives deterministic names but does not provision the corresponding R2 bucket or Queue.

Blob, Agent, Auth, Database, Email, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace are opt-in. Enabling Agent also enables Workflow for discovered Agent Definitions; set `workflow: false` only when every Agent must stay inline:

```ts
vitehub({
  agent: true,
  blob: true,
  preset: "cloudflare",
  auth: true,
  database: true,
  email: {
    driver: "resend",
  },
  kv: true,
  queue: true,
  rateLimit: true,
  sandbox: true,
  schedule: true,
  workflow: true,
  workspace: true,
});
```

| Preset       | Blob                           | Queue             | Rate Limit                      | Sandbox               | Schedule    |
| ------------ | ------------------------------ | ----------------- | ------------------------------- | --------------------- | ----------- |
| `cloudflare` | R2                             | Cloudflare Queues | Cloudflare                      | Cloudflare Containers | Supported   |
| `netlify`    | Netlify Blobs                  | Unsupported       | Unsupported                     | Unsupported           | Supported   |
| `vercel`     | Vercel Blob                    | Vercel Queues     | Unsupported                     | Vercel Sandbox        | Supported   |
| `deno`       | Unsupported                    | Unsupported       | Unsupported                     | Unsupported           | Unsupported |
| `node`       | Local filesystem (single host) | Unsupported       | Process memory (single process) | Unsupported           | Supported   |

Selecting an unsupported opt-in capability fails the build with the preset policy. You can instead configure an explicit Blob driver through `blob` or compose an owner package directly when the application provides its own portable implementation.

The Deno preset uses Nitro's Deno entrypoint, so it rejects Schedule and `agent.runtime: "deno"`; those owner-package outputs require an explicit deployment integration.

The Deno preset emits `.output/deno.json`, stages emitted runtime packages and installed optional native dependencies under `.output/node_modules`, and writes `.output/deploy.mjs`, a non-interactive create-or-update runner used by the `node ./deploy.mjs` command in `.output/nitro.json`; set `DENO_DEPLOY_ORG` before deployment. The runner uses the resolved deployment identity as its app name, with `DENO_DEPLOY_APP` as an optional override, and uploads node modules when it creates or updates an app. The Node preset emits a plain Node server artifact suitable for a VPS or container image; Docker is not a hosting preset.

## Build, inspect, and deploy

The preset tells ViteHub which integrations and Provider Output to generate. Depending on the host and enabled features, a build can write Runtime Registries under `.vitehub`, Cloudflare Worker output and `wrangler.json` under `dist`, Vercel Build Output under `.vercel/output`, Netlify functions under `.netlify/v1`, or Node and Deno artifacts under `.output`.

A successful build proves that ViteHub discovered the configured definitions and wrote the selected output. It does not prove that remote resources exist, credentials are valid, deployment succeeded, or a hosted provider completed a live operation. Follow the selected [host guide](https://vitehub.dev/docs/frameworks-hosts) for provisioning, environment variables, deployment commands, and current proof.

Generated files are for inspection and deployment. Application code must not import `.vitehub/**`, provider output directories, Vite virtual module IDs, or `vite-hub/_internal/*`. Use the public paths in the [import reference](https://vitehub.dev/docs/reference/import-paths).

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
import { defineAgent } from "vite-hub/agent";
import { workspaceShell } from "vite-hub/agent/capabilities";
import { env } from "vite-hub/env";
import { renderMarkdownTemplate } from "vite-hub/markdown-template";
import { defineWorkspace } from "vite-hub/workspace";
import { defineWorkflow } from "vite-hub/workflow";
```

The root export intentionally contains only the framework configuration API. Feature code belongs on a feature subpath, which forwards to the package that owns it.

Built-in Agent Drivers and Box runtimes are selected by literal or tagged values, so they do not need provider-specific ViteHub imports. Install an optional external provider or SDK explicitly when its runtime requires one.

## Read the reference

- [Installation and owner-package selection](https://vitehub.dev/docs/getting-started/installation)
- [Configuration options](https://vitehub.dev/docs/reference/config-options)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Generated files](https://vitehub.dev/docs/development/generated-files)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)
