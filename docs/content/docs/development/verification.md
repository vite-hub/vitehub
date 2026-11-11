---
title: Verification
description: Choose the right proof tier for ViteHub primitives and provider behavior.
navigation.order: 35
navigation.group: Proof and recovery
icon: i-lucide-badge-check
---

Use this page to choose the checks that prove a change before you deploy it.
Each check covers a different failure mode, and no single check proves
production readiness. Run the narrowest check that covers the change, then
verify the provider behavior that local checks cannot exercise.

## Verification tiers

| Tier | How to run it | Proves |
| --- | --- | --- |
| Unit or application test | Your test runner with [`vite-hub/test`](/docs/development/testing) | Runtime behavior, config handling, and error branches. |
| Provider Output Contract | `pnpm build`, then `vitehub inspect output` | Generated Provider Output shape without cloud execution. |
| Local Provider Run | Start the built output locally, for example `node .output/server/index.mjs` | Built Provider Output can serve the application behavior. |
| Live Smoke | A deployment to a separate environment | Thin real-provider coverage for the same application behavior. |
| Agent Eval | `vitehub agent eval` | Agent Definition behavior and scored Agent Invocations. |

## Run application checks

Run the application's tests before inspecting generated host output. Tests establish the behavior exercised by their assertions. A production build checks that the selected integrations can generate their artifacts; it does not verify live credentials, access policy, or recovery after a host restart.

```bash [Terminal]
pnpm test
pnpm build
```

## Verify Provider Output

Provider Output Contracts inspect generated files rather than cloud state.
Use them when the change affects bindings, worker bundles, Vercel Build Output, generated functions, cron entries, or runtime imports.

```bash [Terminal]
pnpm build
pnpm vitehub inspect output --json
```

The [Provider output reference](/docs/reference/provider-output) lists the expected artifact families.

## Keep Live Smoke thin

A deployment smoke exercises the same application behavior as the local checks. Keep the deployed check narrow, but verify every provider binding or hosted service that local adapters cannot reproduce.

## Next steps

- Use [Production deployment](/docs/frameworks-hosts/production) to verify application access, persistence, retries, and recovery before rollout.
- Use [Provider output](/docs/reference/provider-output) for generated artifact families.
- Use [Generated files](/docs/development/generated-files) to inspect local output.
- Use [Troubleshooting](/docs/development/troubleshooting) when a proof fails.
