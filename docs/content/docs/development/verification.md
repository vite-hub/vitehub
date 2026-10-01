---
title: Verification
description: Choose the right proof tier for ViteHub primitives and provider behavior.
navigation.order: 35
navigation.group: Proof and recovery
icon: i-lucide-badge-check
---

Verification checks selected behavior across generated output, local provider execution, and live providers. Each tier covers a different failure mode; no single tier establishes production readiness.
Use the narrowest tier that covers the change, then verify the provider behavior that local tests cannot exercise.

## Verification tiers

| Tier | Runs where | Proves |
| --- | --- | --- |
| Unit or package test | Package test suite | Pure runtime behavior, config normalization, and error branches. |
| Provider Output Contract | Pull request check | Generated Provider Output shape without cloud execution. |
| Local Provider Run | Pull request check | Built Provider Output can execute the application proof fixture locally. |
| Live Smoke | Scheduled provider deployment | Thin real-provider coverage for the same application behaviour. |
| Agent Eval | Local or CI behavior check | Agent Definition behavior and scored Agent Invocations. |

## Run application checks

Run the application's tests before inspecting generated host output. Tests establish the behavior exercised by their assertions. A production build checks that the selected integrations can generate their artifacts; it does not verify live credentials, access policy, or recovery after a host restart.

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

- Use [Production deployment](/docs/frameworks-hosts/production) to verify application access, persistence, retries, and recovery before rollout.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Generated files](/docs/development/generated-files) to inspect local output.
- Use [Troubleshooting](/docs/development/troubleshooting) when a proof fails.
