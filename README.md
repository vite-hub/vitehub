<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="240">
  </picture>
</p>

<p align="center">
  The server layer for Vite apps. Databases, storage, queues, workflows, and more.<br>
  Use one API in your app and deploy it to your choice of cloud.
</p>

<p align="center">
  <a href="https://vitehub.dev">Website</a>
  ·
  <a href="https://vitehub.dev/docs/getting-started/first-server-primitive">First Server Primitive</a>
  ·
  <a href="https://vitehub.dev/docs">Docs</a>
</p>

## Server Primitives

Use each primitive alone, or use them together in one app.

<!-- primitives:start -->
<table>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/kv"><img src=".github/assets/primitives/kv.svg" alt="" height="40"><br><b>KV</b></a><br>State and cache</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/blob"><img src=".github/assets/primitives/blob.svg" alt="" height="40"><br><b>Blob</b></a><br>Files and uploads</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/database"><img src=".github/assets/primitives/database.svg" alt="" height="40"><br><b>Database</b></a><br>Relational data</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/queue"><img src=".github/assets/primitives/queue.svg" alt="" height="40"><br><b>Queue</b></a><br>Background jobs</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/workflows"><img src=".github/assets/primitives/workflow.svg" alt="" height="40"><br><b>Workflow</b></a><br>Durable orchestration</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/schedule"><img src=".github/assets/primitives/schedule.svg" alt="" height="40"><br><b>Schedule</b></a><br>Recurring work</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/auth"><img src=".github/assets/primitives/auth.svg" alt="" height="40"><br><b>Auth</b></a><br>Users and sessions</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/connections"><img src=".github/assets/primitives/connections.svg" alt="" height="40"><br><b>Connections</b></a><br>Connected account APIs</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/workspace"><img src=".github/assets/primitives/workspace.svg" alt="" height="40"><br><b>Workspace</b></a><br>Persistent file trees</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/sandbox"><img src=".github/assets/primitives/sandbox.svg" alt="" height="40"><br><b>Sandbox</b></a><br>Isolated execution</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/browser"><img src=".github/assets/primitives/browser.svg" alt="" height="40"><br><b>Browser</b></a><br>Browser operations</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/shell"><img src=".github/assets/primitives/shell.svg" alt="" height="40"><br><b>Shell</b></a><br>Command execution</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/source"><img src=".github/assets/primitives/source.svg" alt="" height="40"><br><b>Source</b></a><br>Read-only content</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/content"><img src=".github/assets/primitives/content.svg" alt="" height="40"><br><b>Content</b></a><br>Parse and search</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/email"><img src=".github/assets/primitives/email.svg" alt="" height="40"><br><b>Email</b></a><br>Transactional email</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/channels"><img src=".github/assets/primitives/channels.svg" alt="" height="40"><br><b>Channels</b></a><br>Named message delivery</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/env"><img src=".github/assets/primitives/env.svg" alt="" height="40"><br><b>Env</b></a><br>Typed configuration</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/rate-limit"><img src=".github/assets/primitives/rate-limit.svg" alt="" height="40"><br><b>Rate Limit</b></a><br>Request budgets</td>
  </tr>
  <tr>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/realtime"><img src=".github/assets/primitives/realtime.svg" alt="" height="40"><br><b>Realtime</b></a><br>Collaborative documents</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/agents"><img src=".github/assets/primitives/agent.svg" alt="" height="40"><br><b>Agent</b></a><br>Portable automation</td>
    <td width="33%" valign="top"><a href="https://vitehub.dev/docs/ui"><img src=".github/assets/primitives/ui.svg" alt="" height="40"><br><b>UI</b></a><br>Agent interfaces</td>
  </tr>
</table>
<!-- primitives:end -->

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

## Get started

```bash
pnpm add vite-hub nitro h3
pnpm add -D vite
```

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "node", kv: true })],
});
```

Nitro serves the routes in `server/` and builds the output for your host. For a complete app, follow the [First Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive) tutorial. It runs offline and needs no account.

If a coding agent writes your app, install the ViteHub skill:

```bash
npx skills add https://vitehub.dev --skill vitehub
```

Requirements: Node 24.15 or newer and Vite 8 or newer. Presets: `cloudflare`, `netlify`, `vercel`, `deno`, and `node`.

## Agents

Agents are one more primitive. Their Capabilities wrap the same primitives that your routes call, so a route can read the KV store that an Agent writes. Start with the [First Agent](https://vitehub.dev/docs/getting-started/first-agent) tutorial.

## Status

ViteHub is in active development and has not reached 1.0. Interfaces can change between 0.x releases, and security fixes land on `main` only. Pin your versions, and read [Prepare a production deployment](https://vitehub.dev/docs/frameworks-hosts/production) before you serve traffic.

## Contributing

See [AGENTS.md](AGENTS.md) for the code map and checks. ViteHub uses the [Apache License 2.0](LICENSE). Report vulnerabilities through the [security policy](SECURITY.md).
