---
title: Local development
description: Prove ViteHub discovery, generated files, Provider Output, and Agent behavior from a local checkout.
navigation.order: 30
icon: i-lucide-terminal
---

Local development proves that ViteHub primitives work before a host deploys them.
Use it to inspect Discovered Definitions, generated runtime files, Provider Output, DevTools state, and Agent Eval results from the same Vite config your app uses.

## Local proof map

| Proof path | Use it for | Output to inspect |
| --- | --- | --- |
| Vite dev server | Definition discovery, runtime imports, DevTools bridges, and local providers | Terminal output, browser behavior, and DevTools Feature state |
| ViteHub CLI | Package-owned command workflows such as Agent Evals and Provision | CLI exit code, concise output, optional JSON files |
| Generated files | Runtime Registries, generated env access, generated Provider Output, and provision state | `.vitehub/**`, `.vercel/output/**`, `dist/**`, or provider config files |
| Package tests | Provider Output Contracts, Local Provider Runs, and package-owned regressions | Vitest output and generated test fixtures |

## Run the local app

Start with the app's normal development command.
ViteHub Vite Integrations run during Vite startup, so discovery and generated local files use the same root as the app.

```bash [Terminal]
pnpm dev
```

In this monorepo, root commands use Vite+.
Run package checks through the package that owns the primitive you are changing.

```bash [Terminal]
pnpm --filter @vite-hub/agent test
pnpm --filter @vite-hub/agent typecheck
```

## Inspect generated state

Generated files are proof, not public authoring surfaces.
Inspect them to debug discovery, but keep application code on Stable ViteHub Import Paths.

```bash [Terminal]
find .vitehub -maxdepth 3 -type f | sort
cat .vitehub/provision.json
```

Common generated paths include env modules, Workspace types, Agent webhook route handlers, schedule Nitro bridge files, and provider deployment output.
The exact files depend on the packages installed and the Provider Selection in the Vite config.

## Use DevTools when behavior is interactive

Use the ViteHub DevTools Client when an Agent Invocation, Chat Capability, Workspace Scope, or DevTools Bridge needs browser inspection.
The DevTools surface should show the package-owned DevTools Features that registered through active Vite Integrations.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { hubDevtools } from '@vite-hub/devtools'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubDevtools(),
    hubAgent(),
  ],
})
```

## Verify before deploy

Run the narrowest check that proves the behavior you changed.
Use a package test for public contract changes, `vitehub agent eval` for Agent behavior, `vitehub provision run --dry-run` for provider resources, and a provider build when generated Provider Output changed.

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm build
```

## Next steps

- Open [CLI](/docs/development/cli) for command-owned proof paths.
- Open [Generated files](/docs/development/generated-files) when a Runtime Registry or Provider Output looks wrong.
- Open [Errors and diagnostics](/docs/reference/errors-diagnostics) for failure families.
