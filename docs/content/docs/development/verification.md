---
title: Verification
description: Choose the right proof tier for ViteHub primitives and provider behavior.
navigation.order: 35
icon: i-lucide-badge-check
---

Verification proves that ViteHub primitives keep working across generated output, local provider execution, and live providers.
Use the narrowest tier that covers the risk introduced by the change.

## Verification tiers

| Tier | Runs where | Proves |
| --- | --- | --- |
| Unit or package test | Package test suite | Pure runtime behavior, config normalization, and error branches. |
| Provider Output Contract | Pull request check | Generated Provider Output shape without cloud execution. |
| Local Provider Run | Pull request check | Built Provider Output can execute the Primitive Suite locally. |
| Live Smoke | Scheduled provider deployment | Thin real-provider coverage for the same Primitive Suite. |
| Agent Eval | Local or CI behavior check | Agent Definition behavior and scored Agent Invocations. |

## Run package checks

Run checks from the owning package first.
The package owns its primitive contracts and test fixtures.

```bash [Terminal]
pnpm --filter @vite-hub/workspace test
pnpm --filter @vite-hub/workspace typecheck
```

When a change affects shared generated Provider Output, run the package build too.

```bash [Terminal]
pnpm --filter @vite-hub/workspace build
```

## Verify Provider Output

Provider Output Contracts inspect generated files rather than cloud state.
Use them when the change affects bindings, worker bundles, Vercel Build Output, generated functions, cron entries, or runtime imports.

```bash [Terminal]
pnpm --filter @vite-hub/database test
pnpm --filter @vite-hub/workflow test
```

## Keep Live Smoke thin

Live Smoke should execute the same Primitive Suite against a real provider deployment.
Do not put deep assertions only in scheduled provider workflows; add them to the Primitive Suite so local and pull request tiers gain the same coverage.

## Next steps

- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Generated files](/docs/development/generated-files) to inspect local output.
- Use [Troubleshooting](/docs/development/troubleshooting) when a proof fails.
