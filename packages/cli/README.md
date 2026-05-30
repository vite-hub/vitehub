# @vite-hub/cli

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="CLI" src="https://img.shields.io/badge/CLI-package%20workflows-18181b?style=flat-square">
</p>

`@vite-hub/cli` loads the local Vite config, collects package-contributed CLI Command Namespaces, and runs package-owned CLI Features. The first namespace is the Agent Package namespace for Agent Evals, exposed as `vitehub agent eval`.

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
import { runViteHubCli } from "@vite-hub/cli"

const exitCode = await runViteHubCli({
  args: ["agent", "eval"],
  cwd: process.cwd(),
})
```

## Entry points

- `vitehub`: binary that discovers package-contributed namespaces from Vite plugins.
- `@vite-hub/cli`: `runViteHubCli()` for programmatic execution and test harnesses.

Learn more at [vitehub.dev](https://vitehub.dev).
