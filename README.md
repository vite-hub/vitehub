<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="240">
  </picture>
</p>

<p align="center">
  Define an Agent in one file. Run it on any supported Vite host.
</p>

<p align="center">
  <a href="https://vitehub.dev">Website</a>
  ·
  <a href="https://vitehub.dev/docs/getting-started/first-agent">First Agent</a>
  ·
  <a href="https://vitehub.dev/docs/agents">Docs</a>
</p>

## One file, one Agent

```ts
// server/agents/review.ts
import { defineAgent } from "vite-hub/agent";
import { browser } from "vite-hub/agent/capabilities";
import { github } from "vite-hub/agent/channels";

export default defineAgent({
  description: "Reviews pull requests.",
  channels: {
    github: github({
      pullRequest: { reconcile: { events: ["opened"] } },
    }),
  },
  driver: "codex",
  workspace: { mode: "write" },
  capabilities: [browser()],
});
```

When a pull request opens, this Agent runs Codex in a persistent Workspace. It can use the browser Capability and the Skills it provides. Codex also has its native coding-agent tools, including shell access; Capabilities add the tools listed in the definition.

- **Channels** start the Agent from GitHub, Slack, HTTP, or web chat.
- **Driver** selects the runner: Codex, Claude Code, an AI SDK model, or your own function.
- **Workspace** gives the Agent a file tree that persists between runs.
- **Capabilities** grant additional tools the Agent can use. The Driver also has its own native tools and permissions.

ViteHub finds the file, connects it to your server, and prepares the output for your host.

## Get started

For a complete runnable setup, follow the [First Agent](https://vitehub.dev/docs/getting-started/first-agent) tutorial. The abbreviated configuration below assumes an existing Vite server application; `vitehub()` registers the build integration but does not create a server entry or framework.

```bash
pnpm add vite-hub
```

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
});
```

The First Agent tutorial runs offline and needs no model key.

Requirements: Node 24.15 or newer and Vite 8 or newer. Presets: `cloudflare`, `netlify`, `vercel`, `deno`, and `node`. See [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for details on each feature.

## Built on Server Primitives

Capabilities use Server Primitives such as [KV](https://vitehub.dev/docs/server-primitives/kv), [Blob](https://vitehub.dev/docs/server-primitives/blob), [Queue](https://vitehub.dev/docs/server-primitives/queue), [Workflow](https://vitehub.dev/docs/server-primitives/workflows), and [Sandbox](https://vitehub.dev/docs/server-primitives/sandbox). You can also call them from ordinary server code without an Agent. See [Server Primitives](https://vitehub.dev/docs/server-primitives).

## Status

ViteHub is in active development and has not reached 1.0. Interfaces can change between 0.x releases, and security fixes land on `main` only. Pin your versions, and read [Prepare a production deployment](https://vitehub.dev/docs/frameworks-hosts/production) before you serve traffic.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks, and [AGENTS.md](AGENTS.md) for the code map. ViteHub uses the [Apache License 2.0](LICENSE). Report vulnerabilities through the [security policy](SECURITY.md).
