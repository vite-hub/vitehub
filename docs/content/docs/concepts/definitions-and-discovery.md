---
title: Definitions and discovery
description: Learn how ViteHub discovers portable declarations and gives them stable runtime identity.
navigation.order: 4
icon: i-lucide-file-code-2
---

A Definition is a portable user declaration that names work or state without depending on one framework runtime. A Discovered Definition is a Definition found by a package's discovery rules.

ViteHub derives Discovery Identity from the discovery location. It does not ask normal app code to invent inline ids for discovered names.

## Why it exists

Location-derived identity makes generated registries, Provider Output, CLI inspection, and runtime calls predictable. It also keeps package-owned discovery rules separate from Definition Options.

This matters for agents because an Agent File Name or agent folder name becomes the discovered Agent identity. `defineAgent({ name })` is not the discovery identity override.

Generated Agent hosts carry that discovery identity as `context.agentIdentity`, typed as `AgentHostIdentity`. Agent Definitions contribute a Workflow with the same discovery identity by default; literal `runtime: false` opts out. An explicit `workflow("name")` binding wins for Workflow identity. `defineAgent({ name })` still takes precedence over host identity for explicit unnamed Workflow bindings and implicit Workspace names. Definition configuration does not change the host's route or registry key. Custom hosts pass the same runtime identity when they invoke an Agent Definition.

## Current discovery examples

```txt [Definition paths]
server/agents/support.ts          -> support
server/agents/docs/agent.ts      -> docs
src/triager.agent.ts              -> triager
server/auth.ts                    -> Primary Auth Definition
server.auth.ts                    -> Primary Auth Definition alias
```

Other primitive pages document their own Definition locations. Keep discovery examples on the package page when the package owns special rules.

Rate Limit is intentionally outside this location-derived model. `requireRateLimit(event, 'image-upload', options)` declares an explicit stable ID at its enforcement point, and the build integration collects that call through the compiler AST.

## Boundary helpers

Definition Boundary Helpers mark files for discovery and validation. A first-class discovered definition file should default-export the package-owned helper directly when a package needs build-extracted Definition Options.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: {
    run: () => 'ok',
  },
})
```

## Inspect it

Inspect the source file and the generated or runtime surface that consumes it. For Agents, CLI inspection and trigger consumers use discovered Agent names. For generated imports, use stable ViteHub import paths documented by the package instead of importing registry files directly.

## Next steps

- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output).
- Read [Agent definitions](/docs/agents/agent-definitions).
- Open the primitive page that owns the Definition type you are using.
