---
title: Workspaces and Sources
description: Choose a writable file tree, read-only content, or a combination of both.
navigation.title: Workspaces and Sources
navigation.order: 2.5
navigation.kind: Concepts
icon: i-lucide-folder-git-2
---

A Workspace gives your app a named file tree. A Source supplies read-only
content from an origin. Mount a Source inside a Workspace when your app or
Agent should read that content alongside its own files.

## Choose where files live

Use a Workspace when you need to create or change files, keep session files,
or inspect a snapshot. Its provider controls storage and persistence. Its
rules control which paths a caller can read or write.

Use a Source when the content belongs elsewhere. For example, documentation
can come from a local directory, and repository content can come from a
remote provider. The Source reads that origin. It does not give the Workspace
permission to change it.

| Requirement | Use |
| --- | --- |
| Save files produced by your app or Agent | A writable Workspace path |
| Read documentation without changing the original | A Source mounted in a Workspace |
| Combine read-only context with saved results | A Source mount and a writable output path |

## A mount becomes a Workspace path

A mount places a Source at a path in the Workspace. Code can then read it
through the Workspace file API. Writes to read-only mounts fail. Choose a
separate writable path for results instead of trying to update the origin.

Follow [the Workspace tutorial](/docs/workspace/get-started) to build a tree,
then [configure mounts and rules](/docs/workspace/configure). The
[Source guide](/docs/source/configure) explains how to choose the origin.

## Give an Agent access deliberately

Declaring a Workspace does not give every Agent access to it. Select the
Workspace and the Scope for the run, then add the Capability the Agent needs.
The Scope and Workspace rules limit the paths it can use.

Read [Workspace capability](/docs/workspace/agent-capability) before giving
an Agent file or shell access. Check [Hosts](/docs/workspace/hosts) for the
provider's persistence and isolation behavior.
