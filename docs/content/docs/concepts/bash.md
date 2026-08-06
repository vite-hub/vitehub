---
title: Bash
description: Understand how Capability-owned executables become one constrained Agent tool.
navigation.group: Core vocabulary
navigation.order: 16
icon: i-lucide-terminal
---

Bash is ViteHub's single model-facing execution surface for executables contributed by Capabilities. It looks like a shell to the Agent, but each call selects a registered executable and passes structured arguments through a Workspace Session.

Bash is not an unrestricted host shell. Only attached Capabilities can contribute commands, and the resolved Agent Definition controls which commands exist for the invocation.

## One tool, many Capability contributions

A browser Capability can contribute a browser executable, while a deployment Capability can contribute its own CLI. ViteHub combines those commands behind one `bash` tool so the Agent sees a stable interface while each Capability keeps its executable contract.

## Choose the execution surface

Use Bash when the Agent benefits from composing a small set of commands. Use structured tools when the operation needs a narrow schema, clear per-action policy, or direct result typing. An Agent Definition can use both.

Read [Workspace Shell](/docs/capabilities/workspace-shell) for the Capability API and [Shell](/docs/server-primitives/shell) for the application-facing execution primitive.
