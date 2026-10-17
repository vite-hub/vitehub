<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="240">
  </picture>
</p>

<p align="center">
  The server layer for Vite apps. Storage, queues, workflows, and more.<br>
  Use one API in your app and deploy it to your choice of cloud.
</p>

<p align="center">
  <a href="https://vitehub.dev">Website</a>
  ·
  <a href="https://vitehub.dev/docs/getting-started/first-server-primitive">First Server Primitive</a>
  ·
  <a href="https://vitehub.dev/docs">Docs</a>
</p>

## Write once, deploy anywhere

```ts
// server/api/settings.get.ts
import { defineEventHandler } from "h3";
import { kv } from "vite-hub/kv";

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get("settings");
  if (error) throw error;
  return settings;
});
```

This route does not change between hosts. The host selects the provider:

| Host       | KV                   | Blob                  | Database          |
| ---------- | -------------------- | --------------------- | ----------------- |
| Cloudflare | Workers KV           | R2                    | D1                |
| Vercel     | Upstash Redis        | Vercel Blob           | libSQL or D1 HTTP |
| Netlify    | Upstash Redis        | Netlify Blobs         | libSQL            |
| Deno       | Deno KV              | S3-compatible         | libSQL            |
| Node       | `fs-lite` or Upstash | `fs` or S3-compatible | SQLite or libSQL  |

Support is different for each primitive. Read the [support matrix](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before you select a host.

## Server Primitives

Use each primitive alone, or use them together in one app.

- **Data:** [KV](https://vitehub.dev/docs/kv), [Blob](https://vitehub.dev/docs/blob), [Database](https://vitehub.dev/docs/database), [Realtime](https://vitehub.dev/docs/realtime)
- **Background work:** [Queue](https://vitehub.dev/docs/queue), [Workflow](https://vitehub.dev/docs/workflows), [Schedule](https://vitehub.dev/docs/schedule)
- **Users and services:** [Auth](https://vitehub.dev/docs/auth), [Connections](https://vitehub.dev/docs/connections), [Email](https://vitehub.dev/docs/email), [Channels](https://vitehub.dev/docs/channels), [Rate Limit](https://vitehub.dev/docs/rate-limit), [Env](https://vitehub.dev/docs/env)
- **Execution:** [Sandbox](https://vitehub.dev/docs/sandbox), [Shell](https://vitehub.dev/docs/shell), [Browser](https://vitehub.dev/docs/browser), [Workspace](https://vitehub.dev/docs/workspace)
- **Content:** [Source](https://vitehub.dev/docs/source), [Content](https://vitehub.dev/docs/content)
- **Agents:** [Agent](https://vitehub.dev/docs/agents), [UI](https://vitehub.dev/docs/ui)

## Get started

```bash
pnpm add vite-hub h3 vite
```

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
});
```

`vitehub()` adds the build integration. It does not create a server entry or a framework. For a complete app, follow the [First Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive) tutorial. It runs offline and needs no account.

If a coding agent writes your app, install the ViteHub skill:

```bash
npx skills add https://vitehub.dev --skill vitehub
```

Requirements: Node 24.15 or newer and Vite 8 or newer. Presets: `cloudflare`, `netlify`, `vercel`, `deno`, and `node`.

## Agents use the same primitives

```ts
// server/agents/review.ts
import { defineAgent } from "vite-hub/agent";
import { browser, kv } from "vite-hub/agent/capabilities";
import { github } from "vite-hub/agent/channels";

export default defineAgent({
  description: "Reviews pull requests.",
  channels: {
    github: github({ pullRequest: { reconcile: { events: ["opened"] } } }),
  },
  driver: "codex",
  workspace: { mode: "write" },
  capabilities: [browser(), kv({ mode: "write" })],
});
```

Your Agents live in your app, not beside it. They share its server, storage, and deploy. Capabilities wrap the same primitives that your routes call, so a route can read the KV store that this Agent writes. Start with the [First Agent](https://vitehub.dev/docs/getting-started/first-agent) tutorial.

## Status

ViteHub is in active development and has not reached 1.0. Interfaces can change between 0.x releases, and security fixes land on `main` only. Pin your versions, and read [Prepare a production deployment](https://vitehub.dev/docs/frameworks-hosts/production) before you serve traffic.

## Contributing

See [AGENTS.md](AGENTS.md) for the code map and checks. ViteHub uses the [Apache License 2.0](LICENSE). Report vulnerabilities through the [security policy](SECURITY.md).
