---
title: Workspace limits and errors
description: Local Store filesystem checks and recovery after a crashed process leaves lock markers.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

These limits and recovery steps apply to Workspace Stores.

## Workspace discovery

Each Workspace name has one definition. A discovered file and a [contributed Workspace](/docs/workspace/configure#contribute-workspace-definitions-from-a-package) with the same name, or two different contributions with one name, fail the build with `WORKSPACE_B0003`. A contribution that is not `{ name, definition: { module, export? }, reason? }`, or that has a relative `definition.module`, fails with `WORKSPACE_B0004`.

## Retained history

Retained-history methods require a Store with `history`. Unsupported Stores and partial Workspace scopes throw `WORKSPACE_R0069`. `vitehub workspace history`, `refs`, and `show` report the same code and name the Blob + Database Store. Invalid list limits and cursors from another ref throw `WORKSPACE_R0070`; limits must be integers from `1` to `100`. Invalid ref names throw `WORKSPACE_R0071`.

A stale `ifHead` throws `WORKSPACE_CONFLICT` with the ref and the expected and actual revision ids. Missing revisions, deleted workspace identities, and change commits that delete a missing file throw `WORKSPACE_NOT_FOUND`. Blob operations retain their `BLOB_*` error codes. Retry failed workspace deletion after the storage error is resolved.

The Blob + Database Store retains all committed revisions on every ref and has no pruning API. `usage()` counts unique retained file bytes. It excludes abandoned uploads and provider metadata, so it is not a measure of billed storage. Workspace `maxBytes` rules apply to changed files; applications own account quotas and retention policy.

## Local filesystem access

Local Stores reject symlinks during reads, file metadata access, writes, directory creation, and explicit listing-prefix resolution. Directory listings omit symlinks. Removing a leaf symlink unlinks the link itself; removal cannot follow a symlink in a parent directory. Empty-directory cleanup preserves symlinks.

Use configured [Source Bindings](/docs/workspace/configure#source-binding-options) to include files from another location. Existing symlink aliases, including links into `.vitehub` metadata, are no longer accepted as Workspace paths.

These checks do not isolate the host filesystem from another process that can change paths during an operation. Use operating-system permissions or a sandbox when untrusted code can write to the same filesystem. Persist the Local Store root on a volume when Workspace files must survive instance replacement.

## Recover a Local Store after a crash

Local Store lock markers do not expire by age. A crashed process can leave a marker that makes later operations report `Timed out waiting to read Workspace` or `Timed out waiting to write Workspace`.

Stop every process using the Workspace before recovery. Prevent changes to the Store and its ancestor directories throughout the call. Then run `recoverLocalWorkspaceLocks()` with the exact directory configured as the Local Store's `root`:

```ts
import { recoverLocalWorkspaceLocks } from '@vite-hub/workspace/runtime'

await recoverLocalWorkspaceLocks({
  root: '/srv/app/.vitehub/workspaces/docs',
  offline: true,
})
```

The `offline: true` flag confirms exclusive offline access; it does not stop other processes. Restart the Workspace processes after recovery succeeds.

Interrupted file removals require a separate retry. If reads report `Interrupted Workspace removal`, retry removal of the reported path with `force: true` and, for directories, `recursive: true` before restoring files. This prevents restored files from reusing deleted Source ownership.
