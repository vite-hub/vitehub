---
title: Workspace limits and errors
description: Workspace error codes, Local Store filesystem checks, and how to recover after a crash leaves lock markers.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Workspace discovery

Each Workspace name has one definition.

- `WORKSPACE_B0003`: a discovered file and a [contributed Workspace](/docs/workspace/configure#contribute-workspace-definitions-from-a-package) share a name, or two contributions share one.
- `WORKSPACE_B0004`: a contribution is not `{ name, definition: { module, export? }, reason? }`, or its `definition.module` is relative.
- `WORKSPACE_B0005`: the build cannot load a definition, and its source does not show a literal object with no `store` or with a literal store that is not `cloudflare-artifacts`. So the build cannot write the Artifacts binding that the store may need. Set the store in the `workspace` config.

## Retained history

Retained-history methods need a Store with `history`.

- `WORKSPACE_R0069`: the Store does not support history, or the Workspace scope is partial.
- `WORKSPACE_R0070`: a list limit is not an integer from `1` to `100`, or a cursor comes from another ref.
- `WORKSPACE_R0071`: a ref name is not valid.
- `WORKSPACE_CONFLICT`: `ifHead` is stale. The error has the ref and the expected and actual revision ids.
- `WORKSPACE_NOT_FOUND`: a revision or workspace identity is gone, or a change commit deletes a missing file.

Blob operations keep their `BLOB_*` error codes. If workspace deletion fails, fix the storage error and retry.

The [GitHub Store](/docs/workspace/configure#github-store) uses branches as refs and commits as revisions. It has no pruning API and never deletes branches or commits.

- `WORKSPACE_R0072`: the repository or token is missing, at the first request.
- `WORKSPACE_R0073`: the commit message or metadata is too large, or the message has a `Vitehub-Metadata:` line.
- `history.head()` caches a branch head for 5 seconds.
- A commit that changes no file does not create a branch.

The Blob + Database Store keeps every committed revision on every ref and has no pruning API. `usage()` counts unique retained file bytes, without abandoned uploads or provider metadata, so it does not measure billed storage. `maxBytes` rules apply to changed files. Your app owns account quotas and retention policy.

## Local filesystem access

Local Stores reject symlinks when they read, write, read file metadata, create directories, or resolve a listing prefix. Directory listings skip symlinks. Removing a leaf symlink removes the link itself. Removal cannot follow a symlink in a parent directory. Empty-directory cleanup keeps symlinks.

To include files from another location, use [Source Bindings](/docs/workspace/configure#source-binding-options). Symlink aliases, including links into `.vitehub` metadata, are not valid Workspace paths.

::warning
These checks do not protect against another process that changes paths during an operation. When untrusted code can write to the same filesystem, use operating-system permissions or a sandbox. To keep files when the instance is replaced, put the Local Store root on a volume.
::

## Recover a Local Store after a crash

Local Store lock markers do not expire. A crashed process can leave one, and later operations report `Timed out waiting to read Workspace` or `Timed out waiting to write Workspace`.

Stop every process that uses the Workspace. Keep the Store and its parent directories unchanged during the call. Then run `recoverLocalWorkspaceLocks()` with the exact `root` of the Local Store:

```ts
import { recoverLocalWorkspaceLocks } from 'vite-hub/workspace/runtime'

await recoverLocalWorkspaceLocks({
  root: '/srv/app/.vitehub/workspaces/docs',
  offline: true,
})
```

`offline: true` confirms that you have exclusive offline access. It does not stop other processes. Restart the Workspace processes when recovery succeeds.

An interrupted removal needs its own retry. If reads report `Interrupted Workspace removal`, remove the reported path again with `force: true`, plus `recursive: true` for directories. Do this before you restore files, so restored files do not reuse deleted Source ownership.
