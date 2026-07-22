---
title: Local development
description: Prove ViteHub discovery, generated files, Provider Output, and Agent behavior from a local checkout.
navigation.order: 30
icon: i-lucide-terminal
---

Local development proves that ViteHub primitives work before a host deploys them.
Use it to inspect Discovered Definitions, generated runtime files, Provider Output, resolved Agent metadata, and Agent Eval results from the same Vite config your app uses.

## Local proof map

| Proof path | Use it for | Output to inspect |
| --- | --- | --- |
| Vite dev server | Definition discovery, runtime imports, Agent Invocation streams, and local providers | Terminal output, CLI behavior, and resolved Agent metadata |
| ViteHub CLI | Package-owned command workflows such as Agent Evals and Provision | CLI exit code, concise output, optional JSON files |
| Generated files | Runtime Registries, generated env access, generated Provider Output, and provision state | `.vitehub/**`, `.vercel/output/**`, `dist/**`, or provider config files |
| Application tests | Runtime Helper behaviour and app-specific regressions | Test output and application fixtures |

## Run the local app

Start with the app's normal development command.
ViteHub Vite Integrations run during Vite startup, so discovery and generated local files use the same root as the app.

```bash [Terminal]
pnpm dev
```

Run the application's normal test and build commands after the development server proves discovery.

```bash [Terminal]
pnpm test
pnpm build
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

## Inspect interactive Agent behaviour

Use [the ViteHub CLI](/docs/development/cli) to inspect Agent metadata or run an Agent Invocation through the local Agent Dev Loop. The canonical Agent page covers registration, discovery, invocation details, and production boundaries.

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
- Open [Agent Evals](/docs/agents/evals) for repeatable Agent behaviour checks.
- Open [Generated files](/docs/development/generated-files) when a Runtime Registry or Provider Output looks wrong.
- Open [Errors and diagnostics](/docs/reference/errors-diagnostics) for failure families.
