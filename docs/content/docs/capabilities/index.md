---
title: Capabilities
description: Attach user-shareable abilities to Agent Definitions without exposing raw runtime authority by default.
navigation.title: Overview
navigation.order: 1
navigation.group: Start here
icon: i-lucide-blocks
---

Capabilities are user-shareable ViteHub abilities that an Agent attaches through `defineAgent({ capabilities })`.
They can add requirements, model-facing tools, Provider Tool contributions, Agent Triggers, pre-invocation decisions, output renderers, metadata, and finish extensions.

A Capability is not a server primitive.
Server primitives give trusted app code authority.
Capabilities decide which parts of that authority become available to an Agent Invocation and which Agent Driver can consume the result.

## Capability lifecycle

ViteHub applies Capabilities in the order listed or returned by the Agent Definition.
It validates duplicate ids, checks runtime requirements, applies Capability Trigger Contributions, and then runs configure, prepare, bind, input, resolve, and output phases for each invocation.

`access()` is the only official Capability with a fixed position rule.
Place it first when an Agent uses it, because later Capabilities may read the scoped Workspace or expose tools after access boundaries apply.

## Attach a Capability

Import official factories from `@vite-hub/agent/capabilities`.
Keep the import path explicit so the Agent Package root stays focused on Agent Definition and invocation primitives.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Attaching a Capability opts the Agent into that ability. Model-facing tool policy defaults to `allow`; set `policy: 'require-approval'` or `policy: 'deny'` when the product needs an additional runtime gate. Capability modes, scopes, allowlists, requirements, and input validation still bound the operation before policy applies.

Use a callback when invocation context decides the Agent Definition's Capability list. ViteHub calls it once after resolving the Agent Invoker and before Capability setup; Capabilities contributed by the active Channel still compose normally.

```ts [server/agents/support.ts]
export default defineAgent({
  driver: { model },
  capabilities: ({ actor }) => [
    workspaceShell({ mode: 'read' }),
    ...(actor.meta?.support === true ? [internalDiagnostics] : []),
  ],
})
```

Return only invocation-scoped behavior from the callback. Capabilities that contribute Agent Triggers, chat admission, or static Workspace Sources must stay in a static list because ViteHub registers those contributions before an invocation exists.

## Use an Eve extension

ViteHub detects compatible Eve extension packages in a static Capability list and compiles their tools into a Capability. Install the extension, then use its existing factory and options:

```ts [server/agents/reviewer.ts]
import github from '@github-tools/eve-extension'
import { defineAgent } from '@vite-hub/agent'

export default defineAgent({
  driver: { model },
  capabilities: [
    github({ preset: 'code-review' }),
  ],
})
```

The Vite plugin reads the package's Eve manifest and fails the build when its contract version or runtime features are unsupported. The first bridge supports one mount per extension package, direct default-import factory calls, static and `session.started` tools, tool schemas and output conversion, and Eve's `always`, `never`, and `once` approval modes.

This bridge is not yet a complete Eve runtime. Tool and approval contexts do not support `getSandbox()`, `getSkill()`, `getToken()`, or `requireAuth()`; using one throws at runtime. Session authentication is unavailable and turn sequence metadata is not preserved, so extensions that depend on those values are not production-ready on ViteHub yet.

## What Capabilities can contribute

| Contribution | What it changes |
| --- | --- |
| Requirements | Primitive, Workspace mode, Workspace path, or policy checks that must pass before the Capability applies. |
| Tools | Model-facing operations exposed only to compatible Agent Drivers. |
| Provider tools | Provider-native tool requests, such as model web search mode. |
| Agent Triggers | Product events that start Agent Invocations through the Agent Package trigger surface. |
| Input behavior | Pre-invocation input transforms, transcription, decisions, gates, and rate limits. |
| Output behavior | Stream renderers, finish extensions, usage records, titles, and summaries. |
| Metadata | Inspectable configuration for runtime diagnostics and CLI inspection. |

Use `defineCapability({ finish })` for metadata that evals, finish hooks, or channel delivery code should read after an invocation.
Agent Evals expose those values through `observation.extensions.get(capabilityId)` and the `hasCapabilityExtension(capabilityId)` scorer.

## Driver boundary

Capabilities attach above the Agent Driver.
A model-backed Agent Driver can consume model-facing tools and Provider Tool contributions.
A harness-backed Agent Driver receives Agent tools through the Harness tool bridge, explicit harness-compatible contributions, and scoped Workspace behavior.
Harness-backed drivers do not support Capability Provider Tool contributions, such as `webSearch({ mode: 'model' })`, and do not receive Capability-authored model instructions unless the Capability exposes them through a harness-compatible surface.
A custom-run-backed Agent Driver receives prepared input and invocation context; the `driver.run` implementation decides which Capability outputs to read.

Free-form guidance about when and why to use a Capability belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Tool descriptions and schemas remain part of the model-facing tool contract.

## Read next

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
