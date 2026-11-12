---
title: Local development
description: Run ViteHub locally, inspect generated files, and verify the behavior you changed.
navigation.order: 30
navigation.group: Local tools
icon: i-lucide-terminal
---

Use this section to run a ViteHub application on your machine and check its
behavior before you deploy it. ViteHub uses the same Vite config to discover
Definitions, write generated files, and resolve Agent metadata in development
and in production builds.

## Choose a local tool

| Tool | Use it for | Output to inspect |
| --- | --- | --- |
| Vite dev server | Definition discovery, server imports, Agent streams, and local providers | Terminal output and responses from your routes |
| [ViteHub CLI](/docs/development/cli) | Package-owned commands such as `inspect`, `agent dev`, `agent eval`, and `provision` | Exit code, terminal output, and optional JSON |
| [ViteHub Console](/docs/development/console) | Discovered Agents, retained sessions, invocation events, and stored data | [console.vitehub.dev](https://console.vitehub.dev), which calls your app |
| [Generated files](/docs/development/generated-files) | Registries, generated types, Provision State, and host output | `.vitehub/**` and the preset's output directory |
| [Bundle reports](/docs/bundle) | Client and server size, startup code, and why each package is in a production build | `vitehub bundle` and `.vitehub/bundle/` |
| [Application tests](/docs/development/testing) | Server API behavior and application regressions with `vite-hub/test` | Test output |

## Run the local app

Start the application with its normal development command. ViteHub integrations
run during Vite startup, so discovery and generated files use the application
root.

```bash [Terminal]
pnpm dev
```

When discovery works, run the application's tests and a production build.

```bash [Terminal]
pnpm test
pnpm build
```

## Inspect what ViteHub discovered

Run `vitehub inspect` while the app is configured. It lists the Definitions that
each enabled package discovered and the host output files that a build writes.
It does not start a server or call a provider.

```bash [Terminal]
pnpm vitehub inspect definitions
pnpm vitehub inspect output
```

Use [`vitehub agent dev`](/docs/development/cli#talk-to-an-agent-during-development)
to talk to an Agent through the running dev server. Open the app in the
[Console](/docs/development/console) when you need session search and
invocation events in a browser.

## Verify before deploy

Run the narrowest check that covers the behavior you changed:

- `vitehub agent eval` for Agent behavior.
- `vitehub provision run --provider <name> --dry-run` for provider resources.
- `pnpm build` when generated host output changed.

[Verification](/docs/development/verification) explains each check and what it
does not cover.

## Next steps

- Open [CLI](/docs/development/cli) for every command and flag.
- Open [Generated files](/docs/development/generated-files) when a registry or host output looks wrong.
- Open [Troubleshooting](/docs/development/troubleshooting) when a check fails.
- Open [Errors and diagnostics](/docs/reference/errors-diagnostics) for failure families.
