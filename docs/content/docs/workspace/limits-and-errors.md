---
title: Workspace limits and errors
description: Local Store filesystem checks and recovery after a crashed process leaves lock markers.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

These limits and recovery steps apply to Workspace Stores.

## Retained history

Retained-history methods require a Store with `history`. Unsupported Stores and partial Workspace scopes throw `WORKSPACE_R0069`. Invalid list limits throw `WORKSPACE_R0070`; limits must be integers from `1` to `100`.

A stale `ifHead` throws `WORKSPACE_CONFLICT` with expected and actual revision ids. Missing revisions and deleted workspace identities throw `WORKSPACE_NOT_FOUND`. Blob operations retain their `BLOB_*` error codes. Retry failed workspace deletion after the storage error is resolved.

The Blob + Database Store retains all published revisions and has no pruning API. `usage()` counts unique retained file bytes. It excludes abandoned uploads and provider metadata, so it is not a measure of billed storage. Workspace `maxBytes` rules apply to changed files; applications own account quotas and retention policy.

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
