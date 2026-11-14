---
title: Workspace hosts
description: Generated Workspace output, types, and Cloudflare Artifacts Store behavior on deployed hosts.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

This page covers generated output and the Cloudflare Artifacts Store. A Store keeps Workspace files. [Store providers](/docs/workspace/configure#store-providers) lists each host's default.

## Provider output

The Workspace package finds definitions, types Workspace names, prepares build assets, and connects Stores. A Store can use Blob, but your code still uses Workspace for files.

::note
The Nuxt Workspace handoff only sets up the hosted runtime and passes the generated registry. It does not add Nitro-specific discovery, public Store constructors, or a second way to define Workspaces.
::

Add the generated types so `useWorkspace()` accepts only discovered Workspace names.

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

The [Blob + Database Store](/docs/workspace/configure#blob-database-store) keeps history the same way on D1, D1 HTTP, and local or hosted libSQL. It publishes with one atomic batch of conditional SQL statements, not interactive transactions, which D1 does not support.

| Table | Stores |
| --- | --- |
| `workspace_history_workspaces` | Workspace namespace and deletion tombstone. |
| `workspace_history_refs` | One row per Workspace and ref name, with head id and sequence. |
| `workspace_history_revisions` | Immutable file manifests, their ref, parent ids, timestamps, messages, metadata, counts, and commit status. |
| `workspace_history_objects` | Digests and sizes registered before upload, including interrupted publications. |
| `workspace_history_metadata` | Workspace metadata used by Sources and lifecycle operations. |

Blob keys are `_vitehub/workspace-history[/<prefix>]/<sha256(workspace identity)>/sha256/<file digest>`. The digest is the SHA-256 of the full file bytes.

- Identical files at any path share one object within a workspace.
- Each workspace has its own namespace. There are no cross-workspace reference counts, so deleting one workspace cannot remove another's bytes.
- MIME types and file metadata belong to each manifest entry.

A commit uploads only missing digests. Two writers can both write the same bytes to one key. The Database batch creates the ref row on first use, inserts the candidate manifest, compares and updates the ref head, and commits only the winning revision. A failed batch rolls back the head. Losing candidates are not in `list()`, `open()`, or `usage()`.

- `open()` on a revision reads the manifest without downloading the tree.
- `readFile()` downloads one object and checks its size and hash.
- Normal staged file operations load the current folder into instance memory. Keep folders small, such as one document or a bounded app file set.
- Retained usage counts unique uncompressed file bytes, not provider billing.
- `maxBytes` limits one changed file, not retained history or account usage.

Use a Blob backend with strong read-after-write consistency and atomic file writes, such as R2 or filesystem Blob. For Netlify Blobs, select strong consistency. An eventually consistent backend can report an object missing right after publication. Each file's MIME type lives in the manifest, not the Blob, so filesystem renames cannot change old MIME types. Filesystem staging files left by a stopped process need [Blob maintenance](https://github.com/vite-hub/vitehub/tree/main/packages/blob#vite-integration).

Deletion writes a permanent Database tombstone that blocks publishers, then removes bytes with the object catalog and a paginated Blob sweep. Blob and Database do not share a transaction. A request that stops during upload can leave an unreferenced object. Stop abandoned requests, then retry deletion to remove it. Live-history pruning and cross-workspace dedupe are not implemented.

## Cloudflare Artifacts

Select Cloudflare Artifacts when a deployed Worker must keep Workspace state:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    workspace: {
      store: {
        provider: 'cloudflare-artifacts',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
        },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
        },
      },
    }),
  ],
})
```
:::
::

The Vite integration adds Artifacts Stores for the module and each definition to the generated Cloudflare config. It reads the `store` of a definition when it loads the definition at build time. If the build cannot load a definition, it fails with `WORKSPACE_B0005`, unless the source shows a literal object with no `store` or with a literal store that is not `cloudflare-artifacts`. Then set the store in the `workspace` config. When the provider changes, it removes only bindings that Workspace generated. One binding name for two namespaces fails the build. Each named Workspace uses the repository `<repoPrefix><encoded-workspace-name>` unless `repo` selects one, so names with unsafe characters stay isolated.

`workspace.snapshot()` commits and pushes the current file tree. The snapshot id is the pushed Git commit SHA. File metadata lives in the repository with the tree, so Source write protection and media types survive a new Worker instance.

The Artifacts adapter does not implement `history.commit`, `head`, `list`, `open`, or `usage` yet. They throw the retained-history capability error. Git snapshots stay available through `history.checkpoint()`.

::warning
Cloudflare Artifacts is in open beta and is not on Workers Free, so the Cloudflare default stays the ephemeral `memory` Store. The Worker adapter clones into isolate memory, so keep these Workspaces small. The Artifacts repository limit is not a usable Worker checkout size.
::

For large repositories in a sandbox, container, or VM, use Cloudflare's [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) directly.

Artifacts repositories are private Git storage. When an Agent needs a public URL, use [Blob](/docs/blob) with R2 or another provider.
