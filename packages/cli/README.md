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
pnpm vitehub agent eval
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

Commands come from Vite plugins, so package CLIs can stay package-owned. The first public namespace is `vitehub agent eval` from [`@vite-hub/agent`](../agent/README.md), backed by [Evalite](https://v1.evalite.dev/).

Learn more at [vitehub.dev](https://vitehub.dev).
