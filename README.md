<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="360">
  </picture>
</p>

<p align="center">
  Server APIs and portable Agents across Vite hosts.
</p>

<p align="center">
  <a href="https://vitehub.dev">Documentation</a>
  ·
  <a href="https://vitehub.dev/docs/getting-started/installation">Installation</a>
  ·
  <a href="https://vitehub.dev/docs/agents">Agents</a>
  ·
  <a href="https://vitehub.dev/docs/server-primitives">Server primitives</a>
</p>

ViteHub adds a server layer to Vite applications. Call Server Primitives directly for auth, storage, background work, and other server behavior. Define an Agent when a named server-side actor needs a model, tools, or a coding provider. Use both when an Agent needs selected operations from the application.

ViteHub keeps feature imports consistent while its Vite integrations discover definitions and prepare output for the selected host.

## Choose what to build

| You need                                     | Start here                                                                                                                      | First result                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Server behavior without an Agent             | [First Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive)                                       | A credential-free local KV route writes and returns one value.      |
| A named Agent Invocation                     | [First Agent](https://vitehub.dev/docs/getting-started/first-agent)                                                             | An offline Agent route returns a deterministic greeting.            |
| An Agent that can use application operations | [First Agent](https://vitehub.dev/docs/getting-started/first-agent), then [Capabilities](https://vitehub.dev/docs/capabilities) | The Agent runs first, then receives only the operations you select. |

Agents can compose Server Primitives. Server Primitives never require Agents.

Applications should install the `vite-hub` framework distribution. It provides one Vite integration and public feature imports such as `vite-hub/agent` and `vite-hub/kv`. Libraries and custom integrations can install an `@vite-hub/*` owner package directly. Use the [package reference](https://vitehub.dev/docs/reference) to choose one.

## Install the framework distribution

Install the framework distribution in a Vite application:

```bash
pnpm add vite-hub
```

Register the Vite integration:

```ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ preset: "node" })],
});
```

Requirements: Node 24.15 or newer, Vite 8 or newer, and a server app with `vite.config.ts`.

## Check project and host support

ViteHub is under active development and has not reached 1.0. Published 0.x packages are development snapshots, and interfaces may change as the final design settles. Security fixes land on the current `main` branch; published 0.x versions do not receive backports. Pin the versions you deploy and test upgrades before rollout. See the [security policy](SECURITY.md) for the supported-version policy and private reporting process.

Choose a built-in `cloudflare`, `netlify`, `vercel`, `deno`, or `node` deployment preset. Each enabled feature validates its host and provider requirements, and unsupported production combinations fail during configuration or build. Provider availability still differs by feature, so check [runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) before choosing a deployment target.

## How Agents work

- An **Agent Definition** declares one Agent and selects its Agent Driver.
- An **Agent Driver** runs an Agent Invocation with a model, a coding provider, or application code.
- An **Agent Invocation** is one runtime request to an Agent.
- **Capabilities** add selected tools, instructions, triggers, policies, or context.
- A **Workspace** gives an Agent a file tree. **Sources** mount read-only files or remote content into it.
- Vite integrations discover definitions and prepare the files and host configuration needed at runtime.

Server code can call primitives directly. Agents do not receive every primitive by default; attach a Capability when the model needs one.

## Server primitives

Server primitives are useful with or without Agents.

| Need                           | Start with                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Environment values and secrets | [`vite-hub/env`](https://vitehub.dev/docs/server-primitives/env)             |
| Auth and sessions              | [`vite-hub/auth`](https://vitehub.dev/docs/server-primitives/auth)           |
| Small key-addressed state      | [`vite-hub/kv`](https://vitehub.dev/docs/server-primitives/kv)               |
| Relational data                | [`vite-hub/database`](https://vitehub.dev/docs/server-primitives/database)   |
| Uploads and generated assets   | [`vite-hub/blob`](https://vitehub.dev/docs/server-primitives/blob)           |
| File-tree state and Sources    | [`vite-hub/workspace`](https://vitehub.dev/docs/server-primitives/workspace) |
| Background delivery            | [`vite-hub/queue`](https://vitehub.dev/docs/server-primitives/queue)         |
| Durable long-running work      | [`vite-hub/workflow`](https://vitehub.dev/docs/server-primitives/workflows)  |
| Delayed or recurring work      | [`vite-hub/schedule`](https://vitehub.dev/docs/server-primitives/schedule)   |
| Isolated execution             | [`vite-hub/sandbox`](https://vitehub.dev/docs/server-primitives/sandbox)     |

Each package provides its server API and Vite integration. Application code uses the same imports while the integration connects them to the selected host.

Libraries and focused integrations can depend on any `@vite-hub/*` owner package directly.

## Learn more

- [Installation](https://vitehub.dev/docs/getting-started/installation)
- [Package reference](https://vitehub.dev/docs/reference)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Agent Definitions](https://vitehub.dev/docs/agents/agent-definitions)
- [Capabilities](https://vitehub.dev/docs/capabilities)
- [Server primitives](https://vitehub.dev/docs/server-primitives)
- [Runtime imports](https://vitehub.dev/docs/reference/import-paths)

## Development

This repo requires Node 24.15 or newer and Deno 2.9.3. Use the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/) to install the pinned version. `.tool-versions` supplies that version to local checks and CI.

From a clean checkout, let Corepack select pnpm 10.33.0 from `package.json` and install the workspace dependencies. This also installs Vite+.

```sh
corepack pnpm install --frozen-lockfile
```

Check the contributor tools without running tests:

```sh
corepack pnpm exec vp run preflight
```

Then run the full local gate:

```sh
corepack pnpm exec vp run verify
```

`verify` runs the preflight first and includes the native Deno package consumer test. A missing or different Deno version is a contributor setup error, not a ViteHub runtime failure. Package scripts own package-local test, build, and typecheck behavior.

## Project policies

ViteHub is available under the [Apache License 2.0](LICENSE). Report suspected vulnerabilities through the [security policy](SECURITY.md) before sharing details publicly.
