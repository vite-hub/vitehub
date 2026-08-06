---
title: From Definition to Invocation
description: "Follow one ViteHub declaration from source code through discovery, host output, and runtime execution."
navigation.group: Start here
navigation.order: 3
icon: i-lucide-workflow
---

ViteHub separates what you declare from where it runs. A Definition names reusable work, a Vite Integration discovers and prepares it, and a Runtime Helper or Agent Invocation executes it.

## The flow

| Stage | What happens |
| --- | --- |
| Definition | You export a package-owned declaration such as an Agent, Workspace, Queue, or Workflow. |
| Discovery | The package applies its file and naming rules and gives the declaration a stable identity. |
| Integration | The package Vite Integration registers build and development behavior. |
| Provider Output | The integration emits host-specific routes, bindings, functions, workers, or other deployment artifacts. |
| Runtime call | Application code calls a stable Runtime Helper, or an entry surface starts an Agent Invocation. |
| Inspection | CLI and runtime surfaces show the resolved declaration, generated output, and execution records. |

## The two ViteHub lanes

Server Primitives give trusted application code direct runtime APIs. Agents compose an Agent Definition from an Agent Driver, Capabilities, Workspace context, and invocation identity.

An Agent can use Server Primitives through Capabilities, but application code does not need an Agent to use a Server Primitive. That distinction keeps ordinary server work from inheriting model-facing policy and invocation behavior.

## What crosses each boundary

- A Definition carries portable configuration.
- Runtime Context carries host facts and trusted resources.
- Agent Invocation input carries task data for one request.
- Provider Output carries generated deployment artifacts.
- Capabilities carry selected model-facing abilities.

Keeping these values separate lets a custom host call the same Definition without reading framework globals or importing generated internals.

## Inspect the flow

Start with the Definition file, then inspect the generated `.vitehub` output and the Runtime Helper or Agent entry point that consumes it. Use [Reference](/docs/reference) when you need an exact generated file or event contract.

Read [Definition discovery](/docs/concepts/definitions-and-discovery) for naming, or [Runtime Context](/docs/concepts/runtime-context) for the host handoff.
