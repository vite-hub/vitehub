---
title: DevTools
description: Inspect Agent discovery, triggers, invocations, driver metadata, Workspace context, and Capability output during development.
navigation.order: 31
icon: i-lucide-panels-top-left
---

The ViteHub DevTools Client is the development inspection surface shared by ViteHub packages. The Agent Package registers an Agent DevTools Feature and DevTools Bridge when `hubAgent()` is active.

Use DevTools to inspect what ViteHub discovered, which Agent Driver is active, which Capabilities applied, how Workspace context resolved, and how one Agent Invocation moved through runtime state.

## Register the Agent feature

Install the Agent Vite integration in the host app. The package registers its DevTools Feature automatically unless you disable Agent DevTools.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubAgent()],
})
```

When the shared ViteHub DevTools Integration is present, the hosted ViteHub DevTools Client discovers package-owned features through the DevTools Discovery Surface.

## Inspect discovery

Use the Agent DevTools Feature to answer the basic discovery questions before debugging behavior.

| Surface | What to verify |
| --- | --- |
| Agent Definitions | The expected files under `server/agents` were discovered with the expected Agent File Name. |
| Agent Driver | The active driver is `model`, `harness`, or `run`, with expected model or harness metadata. |
| Capabilities | The Agent attached the expected Capability Definitions and requirements. |
| Agent Invoker Profiles | DevTools can select configured profiles before a new Chat Session starts. |
| Workspace | Visible Sources and Workspace Scope match the selected invocation. |

If discovery is wrong, fix the Agent Definition before inspecting model output.

## Inspect an invocation

DevTools should show each Agent Invocation through the same public runtime boundaries used by server routes and trigger consumers.

| Runtime fact | Why it matters |
| --- | --- |
| Input and messages | Proves the trigger or route prepared the right Agent Invocation input. |
| Agent Invoker | Shows which trusted identity Capabilities received. |
| Run metadata | Connects the invocation to origin, channel, message, thread, or schedule facts. |
| Tools and policy | Shows model-facing tools, approval decisions, and tool results. |
| Usage record | Normalizes driver usage, latency, provider details, and cost context when available. |

Use a deterministic Agent or custom `driver.run` when the goal is to test DevTools behavior without model-provider cost.

## Debug Capabilities

When Capability behavior is confusing, inspect it in Capability Lifecycle order.

1. Requirement validation.
2. Tool exposure.
3. Policy and approval decisions.
4. Agent Invocation Context Values.
5. Finish extension output.

This order keeps debugging anchored to ViteHub's public model instead of package internals.

## Production boundaries

DevTools are development inspection tools. Do not depend on DevTools-only state as production persistence, authorization, or billing evidence.

Use runtime logs, Agent Usage Records, provider output, and durable state providers for production checks.

## Next steps

- Read [Invocations](/docs/agents/invocations) for the lifecycle DevTools displays.
- Read [Workspace context](/docs/agents/workspace-context) for Source and scope metadata.
- Read [Evals](/docs/agents/evals) for repeatable behavior checks outside the playground.
