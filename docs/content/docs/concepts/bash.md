---
title: Bash
description: Understand how Capability commands become one constrained Agent tool.
navigation.order: 16
navigation.lanes: [agents]
icon: i-lucide-terminal
---

Bash is the tool an Agent uses to run commands contributed by its Capabilities. Each call selects a registered executable and passes its arguments through a Workspace Session.

Bash is not an unrestricted host shell. The Agent Definition and its selected Capabilities determine which commands exist for the invocation.

## Many commands share one tool

A browser Capability and a deployment Capability can each contribute a command. ViteHub exposes both through one `bash` tool, but each Capability still defines its own arguments and behavior.

Use Bash when an Agent needs to combine commands. Use a structured tool when an operation needs typed input and output or a separate policy for each action.

Read [Workspace Shell](/docs/capabilities/workspace-shell) for the Capability API and [Shell](/docs/server-primitives/shell) for the application-facing execution primitive.
