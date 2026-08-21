---
title: Local development
description: Run ViteHub locally, inspect generated files, and verify the behavior you changed.
navigation.order: 30
icon: i-lucide-terminal
---

Run the application locally before testing a hosted build. ViteHub uses the same
Vite config to discover definitions, prepare generated files, and resolve Agent
metadata.

## Local proof map

| Proof path | Use it for | Output to inspect |
| --- | --- | --- |
| Vite dev server | Definition discovery, server imports, Agent streams, and local providers | Terminal output, CLI behavior, and resolved Agent metadata |
| ViteHub CLI | Package-owned command workflows such as Agent Evals and Provision | CLI exit code, concise output, optional JSON files |
| Generated files | Registries, generated env access, deployment output, and provision state | `.vitehub/**`, `.vercel/output/**`, `dist/**`, or provider config files |
| Application tests | Server API behavior and application regressions | Test output and application fixtures |

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

Generated files help you debug discovery and host output. Do not import them from
application code unless a reference page documents the path.

```bash [Terminal]
find .vitehub -maxdepth 3 -type f | sort
cat .vitehub/provision.json
```

Common generated paths include env modules, Workspace types, Agent webhook route
handlers, schedule Nitro bridge files, and deployment output. The installed
packages and selected host determine which files appear.

## Inspect interactive Agent behaviour

Use [the ViteHub CLI](/docs/development/cli) to inspect Agent metadata or run an
Agent locally. The [Agents overview](/docs/agents) links to registration,
invocation, and deployment details.

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
- Open [Agent Evals](/docs/agents/evals) for repeatable Agent behavior checks.
- Open [Generated files](/docs/development/generated-files) when a Runtime Registry or Provider Output looks wrong.
- Open [Errors and diagnostics](/docs/reference/errors-diagnostics) for failure families.
