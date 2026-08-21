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
| Local Provider Run | Pull request check | Built Provider Output can execute the application proof fixture locally. |
| Live Smoke | Scheduled provider deployment | Thin real-provider coverage for the same application behaviour. |
| Agent Eval | Local or CI behavior check | Agent Definition behavior and scored Agent Invocations. |

## Run application checks

Run the application's tests before inspecting generated host output. A successful test suite proves application behaviour, while a production-shaped build proves that the selected integrations can generate their current artifacts.

```bash [Terminal]
pnpm test
pnpm build
```

## Verify Provider Output

Provider Output Contracts inspect generated files rather than cloud state.
Use them when the change affects bindings, worker bundles, Vercel Build Output, generated functions, cron entries, or runtime imports.

Inspect the selected host directory after the build. The [Provider output reference](/docs/reference/provider-output) lists the expected artifact families.

## Keep Live Smoke thin

A deployment smoke exercises the same application behavior as the local checks. Keep the deployed check narrow, but verify every provider binding or hosted service that local adapters cannot reproduce.

## Next steps

- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Generated files](/docs/development/generated-files) to inspect local output.
- Use [Troubleshooting](/docs/development/troubleshooting) when a proof fails.
