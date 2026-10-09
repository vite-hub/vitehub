---
title: Workspace server API
description: Read, write, diff, snapshot, sync, and run sessions on a Workspace from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

Use these imports and methods to work with a Workspace from server code.

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkspace` from `@vite-hub/workspace` | Declare a Workspace Definition. |
| `useWorkspace` from `@vite-hub/workspace` or `@vite-hub/workspace/runtime` | Read, write, diff, snapshot, sync, or start sessions for a Workspace. |
| `file`, `glob`, `github`, `markdown`, `mcpResources`, `fetch`, `custom` from `@vite-hub/workspace` | Declare Workspace Source Bindings. |
| `createWorkspaceTools` from `@vite-hub/workspace` or `@vite-hub/workspace/ai` | Build AI SDK tools from Workspace access. |
| Source resolution, request, and preparation helpers from `@vite-hub/workspace/runtime` | Integrate resolved Workspace Sources and process-local readiness into runtime facades. |
| `defineWorkspaceFileHandler`, `readWorkspaceFileResponse` from `@vite-hub/workspace/server` | Serve Workspace files from H3 routes. |
| `hubWorkspace` from `@vite-hub/workspace/vite` | Register Workspace discovery, generated types, assets, and runtime wiring. |
| `@vite-hub/workspace/loader`, `@vite-hub/workspace/publish`, `@vite-hub/workspace/test` | Add loaders and publishers, or register test Workspaces. |

Workspace definition, Source Binding, rule, hook, store, sync, facade, and session types are exported from `@vite-hub/workspace`. Source resolution runtime types are exported from `@vite-hub/workspace/runtime`.

## Runtime facade

`useWorkspace(name)` returns read access. `useWorkspace(name, { mode: 'write' })` returns write access.

For read-only inspection of an existing Workspace, pass `refresh: false`:

```ts
const workspace = useWorkspace('docs', { refresh: false })
```

This reuses current persisted snapshots of Sources with `materialize: 'startup'`. Snapshots are reused when they are ready and match the current Source configuration, even if upstream content has changed. Missing snapshots or snapshots that no longer match the configuration still materialize. Omitting `refresh`, or setting it to `true`, keeps normal startup Source refresh behavior. Custom Stores that omit `getMeta` or `setMeta` retain ownership and Source snapshots only for the lifetime of the Store instance.

Build and startup overwrites persist a pending checkpoint before changing existing files. Cleanup accepts the new owner only after checkpoint completion, so failed rollback metadata cannot grant ownership of restored files after a Store reopen. If publishing completion fails after the file and owner were committed, the operation reports the error and keeps the generated output. Cleanup preserves that output unless completion was persisted. Retry the Source operation to establish ownership again.

Stores can return `revision` from `stat()` to identify a stored file version. This opaque value must change when the file is modified or recreated, even with identical bytes. A write that makes no change to the stored file can keep its revision. Memory and local Stores provide it. Cleanup uses the revision and content digest to retry interrupted file removal. If the Store cannot identify the surviving file, cleanup preserves it and reports the ambiguous removal for inspection. After inspection, remove the file explicitly if it is still generated output, then retry cleanup.

`refresh: false` applies only to read mode. It does not disable refreshes for other Sources or change explicit `sync()` and `materializeSources()` calls on a writable facade. Write mode keeps normal refresh behavior.

| Surface | Methods |
| --- | --- |
| `workspace.fs` read mode | `readFile`, `stat`, `exists`, `list`, `glob`, `search` |
| `workspace.fs` write mode | read methods plus `writeFile`, `appendFile`, `mkdir`, `rm`, `movePath`, `copyPath` |
| writable facade | `diff`, `snapshot`, `history.checkpoint`, `history.rebase`, `materializeSources`, `sync`, `startSession`, optional Store metadata methods `getMeta` and `setMeta`, and `tools` |
| tools | default tools, `tools.inspect(options)`, `tools.write(options)`, `tools.none()` |

Workspace shell tools do not permit controlled `curl` by default. Pass `sourceRequests: true` to `createWorkspaceTools(workspace, { sourceRequests: true })` or `workspace.tools.inspect({ sourceRequests: true })` to allow requests to visible Source targets. The Agent `workspaceShell()` Capability explicitly enables these scoped requests.

### Runtime method options

| Method | Options | Behavior |
| --- | --- | --- |
| `readFile(path, options?)` | `encoding?: 'utf8' \| 'binary'` | Defaults to UTF-8 text; binary reads return `Uint8Array`. |
| `writeFile(path, content, options?)` | `mediaType?`, `metadata?` | Writes string or binary content with optional file metadata. |
| `list(path?, options?)` | `recursive?: boolean` | Lists direct children or the complete subtree. |
| `glob(pattern, options?)` | `cwd?: string` | Matches one pattern or an array relative to an optional Workspace directory. Returned paths remain relative to the Workspace root. |
| `search(query)` | `pattern`, `cwd?`, `paths?`, `regex?`, `caseSensitive?`, `limit?` | Searches text. Defaults to a case-insensitive literal pattern with a limit of `100`. |
| `mkdir(path, options?)` | `recursive?: boolean` | Creates a Workspace directory. |
| `rm(path, options?)` | `recursive?: boolean`, `force?: boolean` | Removes a file or directory under the active write policy. |
| `movePath(from, to, options?)` | `overwrite?: boolean` | Moves a path. Existing destinations fail unless `overwrite` is enabled. |
| `copyPath(from, to, options?)` | `overwrite?: boolean` | Copies a path. Existing destinations fail unless `overwrite` is enabled. |
| `snapshot(options?)` | `name?: string` | Captures the current Workspace tree with an optional snapshot name. |
| `history.rebase(options?)` | `takeRemote?: string[]` | Reloads a remote Store while preserving staged paths. A listed path takes its remote version only when both sides changed; any other overlapping change remains a conflict. Each listed path must be writable, so a Source-backed path fails. |
| `diff(options?)` | `from?: WorkspaceSnapshot` | Compares the current tree with the supplied snapshot or the Store baseline. |
| `materializeSources(options?)` | `abortSignal?`, `details?: 'paths'`, `onProgress?`, `sources?`, `path?` | Materializes every Source or a selected Source/path subset, with cancellation and progress reporting. |
| `getMeta(key)` / `setMeta(key, value)` | Store-defined | Reads or writes optional Workspace Store metadata when the configured Store implements it. Keys that start with `source:`, `workspace:`, `workspace-file-`, or `loader:` are reserved for Workspace internals, and `setMeta` rejects them. |

When wrapping a writable facade with a replacement `fs`, call `forwardWorkspaceFacade(base, wrapped)` from `@vite-hub/workspace/runtime` to preserve internal Source Sync routing. This forwards enclosing Source guards and durable sync metadata without exposing privileged setters. Keep public writes delegated to the original facade.

Startup and build Source cleanup track ownership by Workspace name. When definitions share a Store, removing or refreshing one definition preserves files last materialized by another definition. Shared paths still contain the most recent write.

File `metadata.source` is reserved for the string name of the Source that owns the file. The local Store rejects other values before writing bytes or consuming a content stream, preserving any existing content and metadata.

Explicit loaders that write through `ctx.store` must preserve the input item's `metadata.source` when multiple build Sources share a mount. For derived output within a Source's mount, set it to that Source's key. An ambiguous write fails before storing the file. This lets later synchronization remove only that Source's output.

Each materialized Source reports its provider, cache disposition, revision, duration, and added, updated, unchanged, and removed file counts. Set `details: 'paths'` when the caller is allowed to inspect file names; path details stay out of the result by default.

## Retained folder history

Use retained history to publish a complete folder and read earlier versions. It is available when the Store implements `history`, including the [Blob + Database Store](/docs/workspace/configure#blob-database-store).

```ts
const workspace = useWorkspace('drop', { mode: 'write' })
const base = await workspace.history.head()
const revision = await workspace.history.commit({
  ifHead: base?.id ?? null,
  files: {
    'index.html': '<h1>Hello</h1>',
    'assets/data.bin': new Uint8Array([0, 255]),
  },
  message: 'Publish the site',
  metadata: { author: 'maxi' },
})

const version = await workspace.history.open(revision.id)
const html = await version.readFile('index.html')
const bytes = await version.readFile('assets/data.bin', { encoding: 'binary' })
const page = await workspace.history.list({ limit: 20 })
const next = page.cursor
  ? await workspace.history.list({ cursor: page.cursor, limit: 20 })
  : undefined
const usage = await workspace.history.usage()
```

`files` is the whole desired file set. Omitted paths are deleted from the next version. Earlier versions keep their bytes. Paths, write rules, `maxBytes`, validators, hooks, and Source write grants apply to additions, changes, and deletions. Unchanged files keep their MIME type and metadata. Validators can change content and file attributes but cannot rename paths or change operations during a history commit. Revision metadata must contain JSON-safe values. The Source ownership restriction on file `metadata.source` does not apply to revision metadata.

`ifHead` is required. Use `null` for the first publication and a revision id for later publications. If the head changes, the commit fails with `WORKSPACE_CONFLICT` and `details.expected` and `details.actual`. Catch `isWorkspaceConflict(error)` and load the new head before resolving the edits. A head conflict never changes the published folder. On an operational error, read the head before retrying; Database responses and post-write hooks can fail after publication.

| Method | Result |
| --- | --- |
| `history.commit({ ifHead, files, message?, metadata? })` | A revision with `id`, `parentId`, `createdAt`, optional message and metadata, file count `files`, and total file `bytes`. |
| `history.head()` | Current revision or `null`. |
| `history.list({ cursor?, limit? })` | `{ revisions, cursor? }`, newest first. Default limit `20`, maximum `100`. Pass the returned cursor unchanged to read older revisions. |
| `history.open(id)` | Read-only view with `revision`, `list(path?, options?)`, `stat(path)`, and `readFile(path, { encoding? })`. Encoding defaults to UTF-8; `'binary'` returns `Uint8Array`. |
| `history.usage()` | `{ bytes, objects }` for unique retained file content across all published revisions. This excludes manifests, Database storage, Blob metadata, and failed uploads. |

Read mode exposes `head`, `list`, `open`, and `usage`. Commit requires write mode. `capabilities().retainedHistory` reports Store support on the writable facade. Stores without retained history throw `WORKSPACE_R0069` for these methods. `history.checkpoint()` and `history.rebase()` keep their existing contracts; a checkpoint is not proof of retained file bytes on every Store.

History covers the Store file tree. It does not capture live Source responses, resumable drafts, or a running Session. Published revisions are immutable until the workspace is deleted. Empty directories are not part of the file-set history contract.

A commit waits for Definition synchronization before checking Source ownership. Synchronization can publish a Source revision and advance the head. If that happens, the commit reports `WORKSPACE_CONFLICT`. Read the new head and retry with the complete file set. Source-owned files cannot be changed or deleted, including materialized files not yet retained in a revision.

Retained history requires access to the complete Workspace. A facade restricted to selected paths or Sources throws `WORKSPACE_R0069` instead of exposing or replacing a complete folder outside that scope.

## Sync Sources

Workspace Source Sync copies selected Source-backed paths into the Workspace Store when the Source sync policy permits it.
Only Sources declared with `sync: true` or a sync policy participate in runtime `workspace.sync()`.

```ts [server/tasks/sync-docs.ts]
import { useWorkspace } from '@vite-hub/workspace'

export async function syncDocs() {
  const workspace = useWorkspace('docs', { mode: 'write' })

  return workspace.sync({
    sources: ['handbook'],
    snapshot: { message: 'Sync handbook source' },
  })
}
```

Build and development integrations materialize Sources at build time. Runtime `sync()` copies Sources into Workspace Stores while the app runs.

### Source sync policy

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `sync` | `boolean \| WorkspaceSourceSyncPolicy` | `false` | `true` enables sync with default policy; an object configures concurrency and stale paths. |
| `sync.concurrency` | `skip \| queue` | `queue` | Queues behind an active sync for the same Source, or reports the overlapping Source as skipped. |
| `sync.stale` | `keep \| remove` | `keep` | Keeps files no longer returned by the Source, or removes them during reconciliation. Removal changes only paths inside the current Source mount. |

### `workspace.sync()` options

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `sources` | `all \| readonly string[]` | required | Selects all sync-enabled Sources or explicit Source keys. |
| `details` | `counts \| paths` | `counts` | Returns per-Source counts, with optional per-path results. |
| `snapshot` | `boolean \| { name?, message? }` | `false` | Creates a snapshot after successful reconciliation. A message is used as the snapshot name when `name` is absent. |
| `publish` | `boolean` | `false` | Publishes the resulting snapshot through configured Workspace Publishers; enabling it also creates a snapshot. |
| `publishPartial` | `boolean` | `false` | Applies and optionally publishes successful Source plans even when another selected Source fails. |

Source Sync requires a Workspace Store with metadata support. Without `publishPartial`, any planning error skips all otherwise valid plans so the sync does not apply only part of the requested selection.

## Use sessions and Shell

Use a Workspace Session when a command needs a materialized file tree and must produce a diff.
`session.exec()` requires an open Box Session. Workspace handles materialization, diff, commit, and rollback. Box runs the command and manages its lifecycle.

```ts [server/tasks/test-docs.ts]
import { resolveBox } from '@vite-hub/box'
import { useWorkspace } from '@vite-hub/workspace'

export async function testDocs() {
  const box = await resolveBox({ runtime: 'trusted-host' }, undefined)
  const host = await box.open()
  const session = await useWorkspace('docs', { mode: 'write' }).startSession({ host })

  try {
    await session.exec('pnpm', ['test'])
    return await session.diff()
  }
  finally {
    await session.close()
    await host.close()
  }
}
```

### Session method options

`startSession(options)` combines Workspace state with an open Box Session. `host` is required for execution. `paths` limits materialization and commits, and `target` defaults to `/workspace`. `abortSignal` cancels preparation, while `onProgress` reports materialization phases. Closing the Workspace Session doesn't close the Box host.

Custom hosts copy Workspace files serially unless they declare a positive `materializationConcurrency` that they can safely support for independent file operations. The local Node host declares a limit of `8`.

Set `writeBack.exclude` to Workspace-relative paths owned by the runtime rather than the invocation. Excluded paths remain usable in the host tree, but their changes are omitted from `diff()` and `commit()` and their pre-Session state is restored by `close()`. Set `writeBack: false` when the runtime must remain writable but its changes must never be published. That mode disables `diff()` and `commit()` and restores the authoritative Workspace on close without first scanning the runtime tree. Read-only Agent Workspaces select it automatically. ViteHub always applies the same excluded-path behavior to `.agent-runs`, `.git`, and `.vitehub`. Integrations that already own a live materialized tree can set `attach: true`; the Session preserves pre-existing live edits, never rematerializes the whole tree, and rolls back only its own uncommitted changes on close. Set `disposableTarget: true` only when the caller owns `target` and deletes it after `close()`; `close()` and failed setup then leave the target as it is, and `commit()` is unchanged. It can't be combined with `attach`.

| Method | Options | Behavior |
| --- | --- | --- |
| `readFile`, `writeFile`, `mkdir`, `rm`, `list`, `glob`, `search` | Same file options as the Workspace filesystem | Operate inside the Session path scope. |
| `exec(command, args?, options?)` | `abortSignal?`, `cwd?`, `env?`, `timeout?` | Runs through the supplied Box Session, defaulting cwd to the Workspace target. Basic Sessions without a host reject this method. |
| `diff()` | none | Returns changes inside the Session path scope. |
| `commit(options?)` | `message?: string` | Writes Session changes back and snapshots them with an optional message. |
| `close()` | none | Rolls an uncommitted host tree back to authoritative Workspace state and releases Session resources. |
| `tools?.aiSdk()` | none | Returns runtime-provided AI SDK tools when the Session supports them. |

### Mount a session with MountX

Use `@vite-hub/workspace/mountx` when an Agent, editor, CLI, or VM needs a filesystem path or protocol instead of Workspace methods. ViteHub keeps the transactional session and commit step. MountX exposes that session through local FUSE, 9P, NFS, or S3 transports.

Install MountX directly before importing its transport entry points:

```bash
pnpm add mountx@0.0.2
```

```ts [server/tasks/edit-docs.ts]
import { createWorkspaceDriver } from '@vite-hub/workspace/mountx'
import { mount } from 'mountx/auto'
import { useWorkspace } from '@vite-hub/workspace'

const session = await useWorkspace('docs', { mode: 'write' }).startSession()

try {
  const mounted = await mount(createWorkspaceDriver(session), '/tmp/vitehub-docs')

  try {
    // Any local program can now use /tmp/vitehub-docs.
  }
  finally {
    await mounted.unmount()
  }

  await session.commit({ message: 'accept projected changes' })
}
finally {
  await session.close()
}
```

Pass `{ readOnly: true }` to `createWorkspaceDriver()` for inspection-only consumers. The same driver can be passed to MountX's 9P or NFS server to reach a Linux guest, or to its S3 gateway for S3-compatible clients. The adapter uses MountX's unstorage driver, so it does not project or persist empty directories, and filenames cannot contain `:`, `?`, or end in `$`. Renames use copy then delete and are not atomic. Executable Git files retain their execute bits; Git symlinks are rejected because the unstorage driver cannot preserve symlink semantics. MountX is alpha and unaudited, so keep network transports loopback-only unless the surrounding sandbox or network is the explicit security boundary.

Workspace stores the file tree and commits. Box and Sandbox provide separate execution environments. Provider Agent Drivers materialize a selected Workspace in their local working directory.

### Run sessions from the CLI

During local development, `vitehub workspace dev` runs commands through a Workspace Session exposed by the Vite development server. Use it to materialize the Workspace, run a command, and commit successful changes. Install `@vite-hub/cli` when your project uses the direct `@vite-hub/workspace` package instead of the `vite-hub` distribution.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
```

`vitehub agent dev` also accepts `!` input for direct commands through the selected Agent's writable Workspace. Use `!` for local shell work in the same Workspace the Agent sees. Use normal messages when the Agent needs to reason about the task.

```bash [Terminal]
pnpm vitehub agent dev --agent support !pnpm test --filter api
```
