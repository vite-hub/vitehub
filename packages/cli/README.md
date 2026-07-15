# @vite-hub/cli

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="CLI" src="https://img.shields.io/badge/CLI-package%20workflows-18181b?style=flat-square">
</p>

`@vite-hub/cli` loads the local Vite config, collects package-contributed commands, and runs them from `vitehub`.

## Install

```sh
pnpm add -D @vite-hub/cli
```

## Minimal API

```sh
pnpm vitehub --help
pnpm vitehub agent info
pnpm vitehub agent dev
pnpm vitehub agent eval
pnpm vitehub db generate
pnpm vitehub db migrate
pnpm vitehub workspace dev docs
pnpm vitehub provision run --provider cloudflare --dry-run
```

```ts
// scripts/vitehub.ts
import { runViteHubCli } from "@vite-hub/cli"

const exitCode = await runViteHubCli({
  args: ["agent", "eval"],
  cwd: process.cwd(),
})
```

## Vite

Commands come from the active Vite plugins, so package CLIs stay package-owned. The Agent integration contributes `agent info`, `agent dev`, and Evalite-backed `agent eval`; Database contributes `db generate` and `db migrate`; Workspace contributes `workspace dev`. The CLI also owns `provision run` for executing package-contributed provider provisioning steps.

Learn more at [vitehub.dev](https://vitehub.dev).
