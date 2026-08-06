---
title: Agents
description: Build and deploy server-side Agents anywhere, using any Model or Harness, selected Capabilities, Workspace context, and tools to inspect each invocation.
navigation.title: Overview
navigation.order: 20
icon: i-lucide-bot
---

## Agent Definitions for any host

Define a server-side Agent, choose one Agent Driver, attach controlled Capabilities, and run Agent Invocations from trusted entry points. Use Agents when model execution, harness execution, custom agent code, Channels, Chat History, Workspaces, evals, or CLI inspection become part of the product.

Start here:

- [Build your first Agent](/docs/getting-started/first-agent)
- [Agent Definition shape](/docs/agents/agent-definitions)
- [Use server primitives without an Agent](/docs/server-primitives)

:::note
**Server code gets Runtime Helpers. Agents get Capabilities.** App routes can call stable imports directly, while an Agent Driver receives only the named abilities that Capabilities expose. Read [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) and [Capabilities API](/docs/concepts/capabilities-api) for the two application-facing boundaries.
:::

## Define the Agent

An Agent Definition keeps the execution boundary visible in one file. The Agent Driver decides how one Agent Invocation runs, while Capabilities add named abilities such as chat, Workspace shell access, storage, web search, or input commands.

| Need | Read |
| --- | --- |
| Declare the server actor, its driver, hooks, context, and abilities | [Agent Definitions](/docs/agents/agent-definitions) |
| Choose model-backed, harness-backed, or custom-run-backed execution | [Agent Drivers](/docs/agents/agent-drivers) |
| Understand how a harness wraps a model and composes with Skills and execution boundaries | [Harness](/docs/agents/harness) |
| Compose model-facing instruction text and explicit primitive coverage | [Instructions](/docs/agents/instructions) |
| Start, stream, and inspect one runtime request | [Invocations](/docs/agents/invocations) |

Define the driver first, then attach the abilities and context the Agent needs.

```ts [server/agents/support/agent.ts]
import { gateway } from '@ai-sdk/gateway'
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'
import { file } from '@vite-hub/workspace'

export default defineAgent({
  driver: {
    model: gateway('openai/gpt-5.1-mini'),
    instructions: [
      'Answer support questions from the connected workspace.',
      'Use the support Source for support policies and known answers.',
      'Inspect Workspace files before using outside knowledge.',
    ],
  },
  workspace: {
    sources: {
      support: file({
        path: 'support.md',
      }),
    },
  },
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

The discovered Agent identity comes from the file or folder name under `server/agents`. `server/agents/support/agent.ts` creates the `support` Agent.

## Reach product surfaces

Channels and Agent Triggers make an Agent reachable from product events without turning delivery, caller identity, or chat state into the same concept.

| Need | Read |
| --- | --- |
| Accept delivery from GitHub, web chat, streams, HTTP, CLI, or chat platforms | [Channels](/docs/agents/channels) |
| Map a Capability-owned or app-owned event into an Agent Invocation | [Triggers](/docs/agents/triggers) |
| Carry trusted caller identity into one Agent Invocation | [Agent Actors](/docs/agents/actors) |
| Bound conversational state and prior messages | [Chat History and sessions](/docs/agents/chat-history-sessions) |

## Add controlled abilities

Agents do not receive server primitives automatically. Attach a Capability only when the active Agent Driver should receive a model-facing ability, policy, trigger, metadata, or context value.

| Need | Read |
| --- | --- |
| Understand the Capability Lifecycle and contribution model | [Capabilities overview](/docs/capabilities) |
| Pick a built-in agent ability | [Official capabilities](/docs/capabilities/official-capabilities) |
| Build an app-owned ability with stable requirements and outputs | [Custom capabilities](/docs/capabilities/custom-capabilities) |
| Expose file inspection or mutation through Workspace and Shell boundaries | [Workspace shell](/docs/capabilities/workspace-shell) |
| Resolve trusted access before model-facing behavior runs | [Access](/docs/capabilities/access) |

## Add Workspace context

Workspace supplies scoped file-tree state and Sources. Capabilities decide which of that context becomes model-facing, writable, or executable.

| Need | Read |
| --- | --- |
| Attach Workspace context to an Agent Definition | [Workspace context](/docs/agents/workspace-context) |
| Understand Workspaces, Sources, mounts, and scope | [Workspace and Sources](/docs/concepts/workspace-and-sources) |
| Use Workspace directly from server code | [Workspace primitive](/docs/server-primitives/workspace) |
| Ingest local, remote, API, or MCP-backed material | [Source primitive](/docs/server-primitives/source) |

## Inspect and verify

Agent behavior should be inspectable without guessing which hook, Capability, Channel, or driver changed the run.

| Need | Read |
| --- | --- |
| Inspect discovery, triggers, invocations, driver metadata, Workspace context, and Capability output | [CLI inspection](/docs/development/cli) |
| Score repeatable Agent behavior outside the playground | [Evals](/docs/agents/evals) |
| Understand approvals, runtime policy, and trace ownership | [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) |
| Read the event vocabulary for usage, trace, lifecycle, and stream records | [Runtime events](/docs/reference/runtime-events) |

## The pieces at a glance

| Concept | Responsibility |
| --- | --- |
| Agent Definition | Declares one Agent, its Agent Driver, Capabilities, Workspace, hooks, and Agent Actor configuration. |
| Agent Driver | Selects model-backed, harness-backed, or custom-run-backed execution for each Agent Invocation. |
| Capability | Adds a named ability and may contribute triggers, tools, policy, metadata, or context values. |
| Agent Invocation | Runs one request through the selected Agent Definition and records lifecycle state. |
| Agent Actor | Carries the trusted caller identity for one Agent Invocation through the current `invoker`-named configuration and input fields. |
| Channel | Names origin, events, delivery, and message facts. It does not replace Agent Actor identity. |
| Workspace | Exposes a scoped file tree and Sources for the Agent to inspect or mutate when allowed. |

## Next steps

- [Run the first Agent](/docs/getting-started/first-agent)
- [Need app infrastructure first?](/docs/server-primitives)
- [Read the Agent model](/docs/concepts/agent-invocations)
