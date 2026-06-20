---
title: How ViteHub fits together
description: Follow the flow from package setup to runtime helpers and agent capabilities.
navigation.order: 3
icon: i-lucide-workflow
---

ViteHub connects portable declarations to runtime behavior through package-owned integrations. The same flow appears across primitives and Agents: configure the integration, declare named work when needed, inspect generated output, and call a stable Runtime Helper.

## The flow

| Step | ViteHub term | What happens |
| --- | --- | --- |
| 1 | Vite Integration | A package plugs into Vite build and dev behavior. |
| 2 | Definition | A file declares named work or state when the primitive needs it. |
| 3 | Discovery Identity | The discovered name comes from file location. |
| 4 | Runtime Registry | Generated runtime code maps discovered names to lazy-loaded Definitions. |
| 5 | Provider Output | Host-specific files, bindings, routes, functions, or crons are emitted when needed. |
| 6 | Runtime Helper | Application code uses the primitive through a stable import. |
| 7 | Capability | Agents receive selected model-facing abilities without gaining every primitive. |

## Package ownership

Package pages describe package-owned behavior. Concept pages describe the vocabulary that crosses packages.

For example, Workspace owns the Workspace File Tree and Sources. The Agent Package can compose visible Source Instructions into model-backed Agent Driver instructions, but it does not make Source retrieval an Agent-owned concept.

## Agent composition

An Agent Definition selects one Agent Driver. It may attach Capabilities, define an Agent Invoker resolver, use Workspace context, and run through Agent Invocations.

Capabilities sit above the Agent Driver. They can contribute tools, instructions, trigger behavior, metadata, policy, requirements, and invocation context values, but they do not dynamically grant new Capabilities at runtime.

## Inspect it

For one feature, trace the path from `vite.config.ts`, to the Definition file, to the Runtime Helper call. When a package emits `.vitehub` files, treat them as proof of generated behavior unless the package documents a stable `#vitehub/...` import.

## Next steps

- Read [Definitions and discovery](/docs/concepts/definitions-and-discovery).
- Read [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports).
- Continue with [First agent](/docs/getting-started/first-agent) when you want to run the flow.
