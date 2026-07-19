---
title: Troubleshooting
description: Diagnose common ViteHub development failures from symptoms to proof paths.
navigation.order: 37
icon: i-lucide-stethoscope
---

Troubleshooting starts from the failed proof path.
Identify whether the failure comes from discovery, generated files, provider resources, Runtime Helpers, DevTools, Agent behavior, or host output before changing code.

## Quick checks

| Symptom | First check | Proof path |
| --- | --- | --- |
| Definition is missing | File path and default export shape | [File conventions](/docs/reference/file-conventions) and `.vitehub/**` |
| Stable import fails | Vite Integration and generated TypeScript includes | [Generated files](/docs/development/generated-files) |
| Provider build fails | Provider Selection and required resource ids | [Provider output](/docs/reference/provider-output) |
| DevTools feature is absent | `hubDevtools()` and package DevTools opt-out | [Agent DevTools](/docs/agents/devtools) |
| Agent changed behaviour | Agent Eval result and Agent Usage Record | [Agent Evals](/docs/agents/evals) |
| Agent proof times out | Dev-loop `--timeout`, `agent.eval.testTimeout`, or stalled harness/session setup | [CLI](/docs/development/cli) and [Agent Evals](/docs/agents/evals) |
| Runtime error lacks context | Package error family and diagnostics output | [Errors and diagnostics](/docs/reference/errors-diagnostics) |

## Discovery failures

Discovery Identity comes from the file location.
Do not add inline ids to force a name; move the file to the expected convention instead.

```txt [File tree]
server/
  agents/
    support.ts
  queues/
    welcome-email.ts
  workspaces/
    docs.ts
```

If a package requires a direct default export of a Definition Boundary Helper, avoid named aggregate exports and local indirection.
The direct export keeps Build-Extracted Definition Options inspectable.

## Provider failures

Provider failures usually belong to one of three layers: missing provider credentials, missing Provision State, or invalid Provider Output.
Dry-run provisioning first, then inspect generated host output.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm build
find dist -maxdepth 4 -type f | sort
```

## Agent failures

Separate Agent runtime failures from model behavior.
Use DevTools to inspect one interactive Agent Invocation, then use Agent Evals when the failure is repeatable behavior.
If the proof is timing out before it reaches the interesting failure, increase the dev-loop `--timeout` or the Agent Eval Runner `agent.eval.testTimeout` in `vite.config.ts`.

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts --output .vitehub/evals/support.json
```

When the Agent Dev Loop reports `Agent Invocation Stream failed.`, first decide whether the invocation is expected to run longer than the configured timeout. If so, rerun with `vitehub agent dev --timeout <ms>`. Public stream errors intentionally omit internal failure messages, so inspect protected server diagnostics to distinguish a timeout from an Agent Driver, Workspace, or harness session failure before changing prompts.

## When to escalate

Escalate to the owning ViteHub package when the same failure reproduces outside application code. Include the smallest reproduction, the generated artifact that failed, and the narrow command that demonstrates the problem.

## Next steps

- Use [Verification](/docs/development/verification) to choose the right check.
- Use [Errors and diagnostics](/docs/reference/errors-diagnostics) to classify the failure.
- Use [Local development](/docs/development) to restart from the full proof map.
