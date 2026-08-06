---
title: Bash
description: Understand how Capability commands become one constrained Agent tool.
navigation.order: 16
navigation.lanes: [agents]
icon: i-lucide-terminal
---

Bash is ViteHub's model-facing tool for running executables contributed by Capabilities. Each call selects a registered executable and passes structured arguments through a Workspace Session.

Bash is not an unrestricted host shell. The Agent Definition and its selected Capabilities determine which commands exist for the invocation.

## Many commands share one tool

A browser Capability and a deployment Capability can each contribute an executable. ViteHub exposes those commands through one `bash` tool while each Capability keeps its own command contract.

Use Bash when an Agent needs to combine a small set of commands. Use a structured tool when an operation needs a narrow input schema, direct result typing, or separate policy for each action.

Read [Workspace Shell](/docs/capabilities/workspace-shell) for the Capability API and [Shell](/docs/server-primitives/shell) for the application-facing execution primitive.
