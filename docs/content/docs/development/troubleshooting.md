---
title: Troubleshooting
description: Find and fix common ViteHub failures, from the symptom to the check that proves the fix.
navigation.order: 37
navigation.group: Proof and recovery
icon: i-lucide-stethoscope
---

Use this page when a local check, build, or deploy fails. Find the layer that
failed, then fix code in that layer. The layers are discovery, generated files,
provider resources, Runtime Helpers, the Agent Dev Loop, Agent behavior, and
host output.

## Quick checks

| Symptom | First check | Proof path |
| --- | --- | --- |
| Definition is missing | File path and default export shape | [File conventions](/docs/reference/file-conventions) and `.vitehub/**` |
| Stable import fails | Vite plugin and generated TypeScript includes | [Generated files](/docs/development/generated-files) |
| Provider build fails | Provider Selection and required resource ids | [Provider output](/docs/reference/provider-output) |
| Agent CLI cannot inspect or invoke | A running Vite server and `agent` on in `vitehub()` | [CLI](/docs/development/cli) |
| Agent changed behaviour | Agent Eval result and Agent Usage Record | [Agent Evals](/docs/agents/evals) |
| Agent check times out | Dev-loop `--timeout`, `agent.eval.testTimeout`, or stuck provider/session setup | [CLI](/docs/development/cli) and [Agent Evals](/docs/agents/evals) |
| Runtime error lacks context | Package error family and diagnostics output | [Errors and diagnostics](/docs/reference/errors-diagnostics) |

## Discovery failures

ViteHub names each definition from its file path. Do not add inline ids to
force a name. Move the file instead.

```txt [File tree]
server/
  agents/
    support.ts
  queues/
    welcome-email.ts
  workspaces/
    docs.ts
```

Some packages need the file to default-export the `define*()` call directly.
Then avoid named aggregate exports and local indirection. A direct export lets
the build read the definition options.

## Provider failures

A provider failure is usually missing credentials, missing Provision State
(the record of created cloud resources), or bad Provider Output (the files built
for the host). Dry-run provisioning, then build and inspect the output.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm build
pnpm vitehub inspect output
```

A build also fails when the host cannot give a feature you turned on. For
example, `queue: true` fails on `netlify` and `deno`, and
`rateLimit: true` fails on `vercel`, `netlify`, and `deno`. Turn the feature off
or set a provider in its package. The
[support matrix](/docs/frameworks-hosts/support-matrix) lists providers per host.

## Agent failures

Tell runtime failures apart from model behavior. Use `vitehub agent dev` to
inspect one run. Use Agent Evals when the bad behavior repeats. If the check
times out before it reaches the failure, raise the dev-loop inactivity
`--timeout` or `agent.eval.testTimeout` in `nuxt.config.ts` or `vite.config.ts`.

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts --output .vitehub/evals/support.json
```

If `agent dev` reports `Agent Invocation Stream timed out after <ms> of inactivity`, ask if the run should stay silent longer than the default. If yes, rerun with `vitehub agent dev --timeout <ms>`. If not, inspect the Driver and any Workspace or provider session setup before you change prompts. For Capability CLI and `!` Workspace commands, the option is a wall-clock deadline, because they send no stream events.

## When to escalate

If the failure also happens outside your app code, report it to the ViteHub package that owns it. Include the smallest reproduction, the generated file that failed, and one command that shows the problem.

## Next steps

- [Verification](/docs/development/verification): choose the right check.
- [Errors and diagnostics](/docs/reference/errors-diagnostics): classify the failure.
- [Local development](/docs/development): start again from the full check map.
