---
title: Workspace vs Source
description: Choose between the persistent file tree that owns files and the origin that provides them.
navigation.group: Choose between
navigation.order: 41
icon: i-lucide-folder-tree
---

Use a Workspace when you need a named, persistent file tree with rules, sessions, snapshots, and writes. Use a Source when you need to expose read-only material from a local file, remote origin, API, or other controlled provider.

## The distinction

| | Workspace | Source |
| --- | --- | --- |
| Owns | File-tree state and file operations | An addressable origin and its read contract |
| Mutability | Can allow writes through Workspace Rules | Read-only by default |
| Placement | Defines the tree and mount point | Appears at a mount inside a Workspace |
| Agent access | Exposed through Workspace context and Capabilities | Visible only when the selected Workspace Scope includes it |

A mount says where the Source appears. It does not make the Source the Workspace or grant the Agent access by itself.

Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for the shared vocabulary and [Workspace](/docs/server-primitives/workspace) for the API.
