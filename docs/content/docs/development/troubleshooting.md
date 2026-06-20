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
| DevTools feature is absent | `hubDevtools()` and package DevTools opt-out | [DevTools](/docs/development/devtools) |
| Agent changed behavior | Agent Eval result and Agent Usage Record | [Agent Evals](/docs/development/agent-evals) |
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

```bash [Terminal]
pnpm vitehub agent eval server/agents/support.eval.ts --output .vitehub/evals/support.json
```

## When to escalate

Escalate to a package-level fix when the same failure appears in the owning package's proof path.
A Downstream Escape should become a Primitive Suite case, an Agent Eval, or a playground reproduction together with the fix.

## Next steps

- Use [Verification](/docs/development/verification) to choose the right check.
- Use [Errors and diagnostics](/docs/reference/errors-diagnostics) to classify the failure.
- Use [Local development](/docs/development) to restart from the full proof map.
