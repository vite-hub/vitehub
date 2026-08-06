---
title: Workspace vs Source
description: Choose between a persistent file tree and a read-only origin.
navigation.group: Choose between
navigation.order: 41
icon: i-lucide-folder-tree
---

Use a Workspace when the application needs a named file tree with rules, persistence, sessions, snapshots, or writes. Use a Source when it needs to expose read-only material from a local file, remote origin, API, or other controlled provider.

## The choice changes what can be written

| | Workspace | Source |
| --- | --- | --- |
| Provides | File-tree state and file operations | An addressable origin and read contract |
| Mutability | Can allow writes through Workspace Rules | Read-only by default |
| Placement | Defines the tree and mount points | Appears at a mount inside a Workspace |
| Agent access | Exposed through Workspace context and Capabilities | Visible only inside the selected Workspace Scope |

A mount says where the Source appears. It does not make the Source the Workspace or grant an Agent access by itself.

Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for the shared vocabulary and [Workspace](/docs/server-primitives/workspace) for the API.
