---
title: Capabilities
description: Give an Agent tools and behavior without handing it unrestricted server access.
navigation.title: Overview
navigation.order: 1
navigation.group: Start here
icon: i-lucide-blocks
---

Capabilities give an Agent a named ability through `defineAgent({ capabilities })`.
They can add tools, triggers, input processing, output metadata, and checks that run before an invocation.

A Capability is not a server primitive.
Server primitives give trusted app code authority.
Capabilities decide which operations an Agent Invocation can use.

## Capability lifecycle

ViteHub applies Capabilities in the order listed or returned by the Agent Definition.
It validates duplicate ids, checks runtime requirements, applies Capability Trigger Contributions, and then runs configure, prepare, bind, input, resolve, and output phases for each invocation.

`access()` is the only official Capability with a fixed position rule.
Place it first so later Capabilities receive the restricted Workspace and tool access.

## Attach a Capability

Import official factories from `@vite-hub/agent/capabilities`.
Import the factory from the Capabilities entry point:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

Attaching a Capability opts the Agent into that ability. Model-facing tool policy defaults to `allow`. Set `policy: 'require-approval'` or `policy: 'deny'` when a tool needs another runtime check. Modes, scopes, allowlists, requirements, and input validation still restrict the operation before policy runs.

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
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: { model },
  capabilities: [
    github({ preset: 'code-review' }),
  ],
})
```

The Vite plugin reads the package's Eve manifest and fails the build when a declared contract version is unsupported. The first bridge supports one mount per extension package, direct default-import factory calls, static and `session.started` tools, tool schemas and output conversion, and Eve's `always`, `never`, and `once` approval modes. ViteHub maps `session.started` to the start of each Agent Invocation and uses the invocation's `runId` as the Eve session ID, so every invocation resolves a fresh tool set without relying on process-local state. The built-in HTTP chat route persists pending approvals in its configured Chat state, reconstructs the authoritative tool call server-side, and consumes each response once under a session lock. Client-supplied chat history never creates approval authority. Unsupported dynamic events fail when ViteHub resolves the extension's tools for an Agent Invocation.

This bridge is not yet a complete Eve runtime. Tool and approval contexts do not support `getSandbox()`, `getSkill()`, `getToken()`, or `requireAuth()`; using one throws at runtime. Session authentication is unavailable and turn sequence metadata is not preserved. ViteHub Agent Invocations are not Eve durable sessions, so extensions that depend on one `session.started` resolution spanning several invocations are not supported yet.

## What Capabilities can contribute

| Contribution | What it changes |
| --- | --- |
| Requirements | Primitive, Workspace mode, Workspace path, or policy checks that must pass before the Capability applies. |
| Tools | Model-facing operations exposed only to compatible Agent Drivers. |
| Provider tools | Provider-native tool requests, such as model web search mode. |
| Agent Triggers | Product events that start Agent Invocations through the Agent Package trigger API. |
| Input behavior | Pre-invocation input transforms, transcription, decisions, gates, and rate limits. |
| Output behavior | Stream renderers, finish extensions, usage records, titles, and summaries. |
| Metadata | Inspectable configuration for runtime diagnostics and CLI inspection. |

Capability metadata appears under the Capability id in Agent inspection output. ViteHub keeps JSON values, sorts object keys and Capability ids, drops unsupported or cyclic values, and redacts keys shaped like auth, API keys, credentials, passwords, secrets, or tokens. Metadata must describe configuration or an explicit check result; it must not include Env values, authentication material, or credentials.

Use `defineCapability({ finish })` for metadata read by evals, finish hooks, or channel delivery code after an invocation.
Agent Evals expose those values through `observation.extensions.get(capabilityId)` and the `hasCapabilityExtension(capabilityId)` scorer.

## Driver support

A model-backed Agent Driver can consume model-facing tools and Provider Tool contributions.
A provider-backed Agent Driver receives Agent tools through the private MCP bridge and scoped Workspace behavior. Provider-backed Drivers do not support model-specific Capability Provider Tool contributions such as `webSearch({ mode: 'model' })`.
A custom-run-backed Agent Driver receives prepared input and invocation context; the `driver.run` implementation decides which Capability outputs to read.

Free-form guidance about when and why to use a Capability belongs in Agent Driver Instructions or deterministic imported instruction Markdown. Tool descriptions and schemas remain part of the model-facing tool contract.

## Next steps

- [Official capabilities](/docs/capabilities/official-capabilities)
- [Custom capabilities](/docs/capabilities/custom-capabilities)
- [Agent definitions](/docs/agents/agent-definitions)
