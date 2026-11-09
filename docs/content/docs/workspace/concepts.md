---
title: Workspaces and Sources
description: Choose a writable file tree, read-only content, or a combination of both.
navigation.title: Workspaces and Sources
navigation.order: 8
navigation.kind: Concepts
icon: i-lucide-folder-git-2
---

A Workspace is a named file tree for your app. A Source is read-only content
from somewhere else. Mount a Source in a Workspace to read that content next
to your own files.

## Choose where files live

Use a Workspace to create or change files, keep session files, or inspect a
snapshot. Its provider controls storage and persistence. Its rules control
which paths a caller can read or write.

Use a Source when the content lives elsewhere, such as docs in a local
directory or a remote repository. The Source reads that origin. It does not
let the Workspace change it.

| Requirement | Use |
| --- | --- |
| Save files produced by your app or Agent | A writable Workspace path |
| Read documentation without changing the original | A Source mounted in a Workspace |
| Combine read-only context with saved results | A Source mount and a writable output path |

## A mount becomes a Workspace path

A mount puts a Source at a Workspace path, so code reads it with the
Workspace file API. Writes to read-only mounts fail. Write results to a
separate writable path instead.

Build a tree in [the Workspace tutorial](/docs/workspace/get-started), then
[configure mounts and rules](/docs/workspace/configure). The
[Source guide](/docs/source/configure) explains how to choose the origin.

## Give an Agent access deliberately

A declared Workspace is not open to every Agent. Select the Workspace and the
Scope for the run, then add the Capability (a permission) the Agent needs.
The Scope and Workspace rules limit the paths it can use.

Read [Workspace capability](/docs/workspace/agent-capability) before you give
an Agent file or shell access. [Hosts](/docs/workspace/hosts) lists each
provider's persistence and isolation behavior.
