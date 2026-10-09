---
title: Workspace hosts
description: Generated Workspace output, types, and Cloudflare Artifacts Store behavior on deployed hosts.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

This page covers generated Workspace output and the Cloudflare Artifacts Store. [Store providers](/docs/workspace/configure#store-providers) lists the default Store for each host.

## Provider output

The Workspace package discovers definitions, generates Workspace name types, prepares build-time assets, and connects Workspace Stores. A Workspace Store can use Blob, but application code still uses Workspace for file operations.

::note
The Nuxt Workspace handoff is only for hosted Workspace runtime setup and generated registry transport. It does not create Nitro-specific Workspace discovery, public provider store constructors, or a second Workspace authoring model.
::

Add generated types when you want `useWorkspace()` to narrow discovered Workspace names.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Blob + Database history

The [Blob + Database Store](/docs/workspace/configure#blob-database-store) uses the same history contract on D1, D1 HTTP, and local or hosted libSQL. Publication uses an atomic batch of conditional SQL statements. It does not use interactive transactions, which D1 does not support.

| Table | Stores |
| --- | --- |
| `workspace_history_refs` | Workspace namespace, head id, sequence, and deletion tombstone. |
| `workspace_history_revisions` | Immutable file manifests, parent ids, timestamps, messages, metadata, counts, and publication status. |
| `workspace_history_objects` | Digests and sizes registered before upload, including interrupted publications. |
| `workspace_history_metadata` | Workspace metadata used by Sources and lifecycle operations. |

Blob keys are `<prefix>/<sha256(workspace identity)>/sha256/<file digest>`. A digest is SHA-256 of the complete file bytes. Identical files at any path share one object within a workspace. Workspaces have separate namespaces. There are no cross-workspace reference counts, and deleting one workspace cannot remove another's bytes. MIME types and file metadata belong to each manifest entry.

Commits check object existence and upload only missing digests. Simultaneous writers can both observe a missing object and write identical bytes to its key. The Database batch inserts the candidate manifest, compares and updates the head, and marks only the winning revision as published. A failed batch rolls back the head. Losing candidates do not appear in `list()` or `open()` and do not count toward `usage()`.

Historical `open()` reads the manifest without downloading the tree. `readFile()` downloads one object and checks its size and hash. Normal staged file operations load the current folder into instance memory. Use deliberately small folders, such as a document or a bounded app file set. Retained usage counts unique uncompressed file bytes, not provider billing. `maxBytes` limits one changed file, not retained history or account usage.

Use a Blob backend with strong read-after-write consistency and atomic file-byte writes. R2 and filesystem Blob stores satisfy this requirement. Select strong consistency for Netlify Blobs. An eventually consistent backend can report an object missing immediately after publication. The Store writes the same Blob content type for every object and keeps per-file MIME types in the manifest, so filesystem payload and metadata renames cannot change historical file MIME types. Filesystem staging files left by a stopped process need [Blob maintenance](https://github.com/vite-hub/vitehub/tree/main/packages/blob#vite-integration).

Deletion fences publishers with a permanent Database tombstone before removing bytes. Cleanup uses the object catalog and a paginated Blob sweep. Blob and Database do not share a transaction. A request that stops during upload can leave an unreferenced object; retry deletion after stopping abandoned requests to remove it. Live-history pruning and cross-workspace dedupe are not implemented.

## Cloudflare Artifacts

Select Cloudflare Artifacts when a deployed Worker needs durable Workspace state:

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
  workspace: {
    store: {
      provider: 'cloudflare-artifacts',
      binding: 'WORKSPACE_ARTIFACTS',
      namespace: 'vitehub',
    },
  },
})
```

The Vite integration adds Artifacts Stores to generated Cloudflare config for the module and discovered definitions. It preserves application bindings and removes only bindings that Workspace generated when the provider changes. Reusing one binding name for different namespaces fails the build. Each named Workspace uses `<repoPrefix><encoded-workspace-name>` unless `repo` selects one repository, so names with repository-unsafe characters remain isolated.

`workspace.snapshot()` commits and pushes the current file tree. Its snapshot id is the pushed Git commit SHA. File metadata is stored in the repository with the Workspace tree so Source-backed write protection and media types survive a fresh Worker instance.

The Artifacts adapter does not yet implement `history.commit`, `head`, `list`, `open`, or `usage`. These methods throw the retained-history capability error. Its Git snapshots remain available through `history.checkpoint()`.

Cloudflare Artifacts is in open beta and is not available on Workers Free, so the Cloudflare default remains the ephemeral `memory` Store. The Worker adapter clones into isolate memory; use it for deliberately small Workspaces rather than assuming the Artifacts repository limit is also a usable Worker checkout size. For large repositories in a sandbox, container, or VM, use Cloudflare's [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) directly.

Artifacts repositories are private Git storage. Use [Blob](/docs/blob) with R2 or another provider when an Agent needs a public delivery URL.
