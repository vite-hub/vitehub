---
title: Workspace configuration
description: Configure the Workspace Vite integration, Store providers, Workspace Definitions, and Source Bindings.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Configure where Workspace stores files, what each Workspace Definition contains, and how Sources are bound into the file tree.

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

The Vite config key is `workspace`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workspace` | `boolean` or `WorkspaceModuleOptions` | disabled | Enables Workspace discovery and runtime wiring through `vitehub()` with `true` or an options object; `false` leaves it disabled. |
| `root` | `string` | `.vitehub/workspaces` | Runtime Workspace root directory. |
| `projectRoot` | `string` | ViteHub project root | Resolves server-side discovery from a custom project root. |
| `assets` | `WorkspaceModuleOptions['assets']` | package default | Controls build-time Workspace asset materialization. Accepts `false`, `true`, or explicit asset paths. |
| `store` | `WorkspaceStoreOptions` | inferred from development mode, hosting, and environment | Default Workspace Store used by definitions that do not choose one. |

## Store providers

| Store | Configure with | Nuance |
| --- | --- | --- |
| Local | `{ provider: 'local', root?: string, locks?: 'filesystem' \| 'process' }` | Filesystem-backed Workspace Store. Used by default in development and on hosts without a more specific match. |
| Memory | `{ provider: 'memory' }` | Test or ephemeral runtime storage. |
| Cloudflare Artifacts | `{ provider: 'cloudflare-artifacts', binding?, namespace?, repo?, repoPrefix?, branch? }` | Opt-in, versioned Git storage. Defaults: binding `WORKSPACE_ARTIFACTS`, namespace `vitehub`, repo prefix `vitehub-workspace-`. |
| Vercel Blob | `{ provider: 'vercel-blob', token?, prefix?, access? }` | Blob-backed storage. Defaults: prefix `.vitehub/workspaces`, access `private`; the token can come from `BLOB_READ_WRITE_TOKEN`. |
| GitHub | `{ provider: 'github', repo?, repository?, branch?, root?, token? }` | Repository-backed storage. Defaults: branch `main`, root `.vitehub/workspaces/<workspace>`. |
| Custom | `WorkspaceStore` | Implement the Workspace Store contract directly. |
| Blob + Database | `createBlobDatabaseWorkspaceStore({ blob, database, workspace, prefix? })` | Portable retained folder history. Pass the returned Store to a Workspace Definition. |

Without a `store`, development uses Local. Production uses Memory on Cloudflare, Vercel Blob when `BLOB_READ_WRITE_TOKEN` exists, Memory on Vercel without that token, and Local on other hosts. You must select Cloudflare Artifacts or GitHub yourself.

Custom Stores can implement `removeEmptyDirectory(path)` for build Source cleanup. It must remove only an empty directory, preserve files and missing paths, and reject nonempty directories within the Store mutation boundary. Without this optional method, cleanup retains generated directories. Local, Memory, and Cloudflare Artifacts implement it.

Public Workspace paths reserve `.git` at any depth and `.vitehub` at the root, regardless of case. This includes NTFS stream suffixes such as `.vitehub::$INDEX_ALLOCATION`, spellings with trailing ASCII periods or spaces such as `.vitehub.`, and NTFS short-name aliases such as `git~1`. ViteHub rejects these spellings on every host.

### Blob + Database Store

Use this Store for immutable folder versions on hosts supported by [Blob](/docs/blob/hosts) and [Database](/docs/database/hosts). Include its schema in a Database Definition, then generate and apply migrations through the Database integration.

```ts [server/databases/history/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { workspaceHistorySchema } from '@vite-hub/workspace/blob-database'

export default defineDatabase({ name: 'history', schema: workspaceHistorySchema })
```

```ts [server/workspaces/drop.ts]
import { blob } from '@vite-hub/blob'
import { defineWorkspace } from '@vite-hub/workspace'
import { createBlobDatabaseWorkspaceStore } from '@vite-hub/workspace/blob-database'
import historyDatabase from '../databases/history/config'

export const dropStore = createBlobDatabaseWorkspaceStore({
  blob: blob.store('workspace-history'),
  database: historyDatabase,
  workspace: 'drop-123',
})

export default defineWorkspace({ store: dropStore })
```

`vite-hub/workspace/blob-database` also exports the constructor and schema. Install `drizzle-orm` when using this subpath. Configure the selected Blob store and Database connection through their integrations. The Store does not create cloud resources or apply migrations at runtime.

Choose one stable workspace identity per document or folder. Use the same identity and prefix after a restart. The default prefix is `vitehub/workspace-history`; custom prefixes accept letters, numbers, underscores, dashes, and single slashes. Each Store owns its Blob namespace. Do not write its objects through another API.

Normal `fs` writes stage changes in the Store instance. Call `snapshot()` or `history.checkpoint()` to publish them. A successful `history.commit()` replaces the staged tree with its complete file set. Failed commits preserve staged changes. Staged changes are lost when the instance stops; published revisions are durable. Other instances observe published heads, and a staged checkpoint fails if its base head moved.

Call `await dropStore.delete()` after application authorization to delete the workspace and all its history. Deletion first tombstones the identity, then removes objects and catalog rows. It is permanent. Use a new identity to create a replacement workspace. Retry `delete()` after a storage outage or after stopping an abandoned in-flight request. The tombstone prevents late commits from publishing. An interrupted upload can leave bytes that a later deletion sweep removes.

The Store retains every published revision. It has no pruning API. Failed or conflicting uploads can leave reusable objects outside retained usage accounting until workspace deletion. See [host storage behavior](/docs/workspace/hosts#blob-database-history).

### Local path locks

Local Stores lock each path before they read or write it. The default, `locks: 'filesystem'`, keeps lock markers under `.vitehub/locks` inside the root, so separate processes that share the root stay coordinated. Set `locks: 'process'` when one process owns the root, for example a disposable checkout that one worker uses. The Store then keeps the same per-path read and write locks in memory. It creates no lock directory, does not poll lock markers, and lists entries in parallel. A waiting writer runs before readers that arrive after it. Process locks do not protect the root from another process.

### Git checkout roots

Set `ignore: 'git'` when the Local Store root is a Git checkout. Listings, snapshots, and diffs then skip `.git` and every path that Git ignores, such as `node_modules` and build output. The Store asks Git for the ignored paths on each listing, so changes to `.gitignore` apply immediately. Git must be installed on the host.

## Workspace Definition options

`defineWorkspace()` accepts these top-level fields. The name comes from the discovered file path.

| Option | Type | Description |
| --- | --- | --- |
| `commit` | `boolean \| string` | Auto-commit all Workspace changes, optionally with a custom message. |
| `rootDir` | `string` | Source root used by loaders. |
| `sourceRootDir` | `string` | Source-specific root for Source helpers. |
| `store` | `WorkspaceStoreOptions` | Store for this Workspace. |
| `bindings` | `Record<string, WorkspaceInstructionBinding>` | Explicit scalar or file-backed values available to Agent Instruction Composition. Values can be `string`, `number`, `boolean`, `null`, or `{ path: string }`. |
| `sources` | `Record<string, WorkspaceSourceInput>` | Workspace Source Bindings. |
| `rules` | `WorkspaceRules` | Read, write, media type, max size, commit, and validation policy by path pattern. |
| `hooks` | `WorkspaceHooks` | Write lifecycle hooks. |
| `plugins` | `WorkspacePlugin[]` | Bundled rules and hooks. |
| `loaders` | `WorkspaceLoader[]` | Build-time or runtime loaders. |
| `publish` | `WorkspacePublisher[]` | Publication behavior after snapshots or sync. |

Instruction text reads scalar bindings with `{{ data.workspace.<name> }}` and file-backed bindings with `:insert{:markdown="data.workspace.<name>"}`. Only keys declared in `bindings` are available; ViteHub does not expose arbitrary Workspace files to Instruction Composition. See [Agent instructions](/docs/agents/instructions#insert-workspace-bindings).

## Source Binding options

Bind a standalone Source definition with `{ source, mount, materialize }`. Reuse
the definition for direct reads or Content:

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source/glob'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'
import { docs } from '../sources/docs'

export default defineWorkspace({
  sources: {
    docs: { source: docs, mount: 'docs', materialize: 'lazy' },
  },
})
```

The Source key `intro.md` appears at `docs/intro.md`. The binding owns placement,
materialization, sync, and access rules. Source owns retrieval. Pass the same
`docs` definition to `createSource(docs)` for direct reads or
`defineContent({ source: docs })` for parsed Content. Each consumer owns its
reader lifecycle and revision.

The Workspace `file()`, `glob()`, and other binding helpers remain available
when a definition is used only in Workspace. Standalone Source loaders use
`defineSource()` for custom retrieval; Workspace's `custom()` helper adds
Workspace binding behavior.

| Option | Type | Description |
| --- | --- | --- |
| `source` | `Source` | Standalone loader definition to bind. Required in the explicit binding form. |
| `mount` | `WorkspaceSourceMount` | Where retrieved items appear in the Workspace file tree. Accepts a path string or Mount options. |
| `materialize` | `WorkspaceMaterializeMode` | Build-time, process-startup, lazy, or disabled materialization. Values: `build`, `startup`, `lazy`, `none`. Startup Sources remain available through lazy reads and can be prepared with `createWorkspacePreparation()`. |
| `cache` | `false or WorkspaceCacheOptions` | Source cache policy. Use `false` to disable caching or `{ maxAge }` to set a TTL. |
| `validate` | `WorkspaceValidateMode` | Request validation mode for API-backed Sources. Use `false` or `request`. |
| `sync` | `WorkspaceSourceSyncConfig` | Enables explicit Workspace Source Sync. Accepts `true`, `false`, or a sync policy. |
| `probeKeys` | `string[]` | Known Source item keys used to check bundled-source completeness and intersect path-scoped access without enumerating the whole Source. File-shaped helpers infer this when possible. |

### Prepare startup Sources

Use `createWorkspacePreparation()` when a process must materialize required Sources before reporting readiness:

```ts
import { createWorkspacePreparation } from '@vite-hub/workspace/runtime'

export const preparation = createWorkspacePreparation({
  retryDelayMs: 10_000,
  workspace: 'docs',
})

await preparation.start()
```

With no explicit `sources`, the controller selects every Source whose `materialize` mode is `startup`. Failed attempts become inspectable error state and retry in the background. `response()` returns a non-cacheable JSON readiness response without exposing internal errors, and `stop()` cancels an active attempt and its retry timer. The state is process-local readiness, not a continuous upstream health or liveness signal.

### Fetch Sources

`fetch(options)` declares an HTTP-backed Source. It can expose one read-only Workspace path, or omit `workspacePath` to remain request-only for runtime Source request integrations. `fetch(resolver)` receives the invocation-aware Source Resolution Context and returns the same options or `false`, `null`, or `undefined`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | required | Request URL. |
| `workspacePath` | `string` | none | Read-only Workspace path for the response. Omitting it creates a request-only Source. |
| `method` | `GET \| HEAD \| POST` | `GET` | Allowed HTTP method. GET and HEAD cannot declare a body. |
| `responseType` | `json \| text` | `json` | Response parser and serialized Workspace content type. |
| `query` | `Record<string, unknown>` | URL query | Static query values. Cannot be combined with `querySchema`. |
| `querySchema` | Standard JSON Schema-compatible schema | none | Validates runtime query input and supplies schema defaults. Cannot be combined with `query`. |
| `body` | `unknown` | none | Static POST body. Cannot be combined with `bodySchema`. |
| `bodySchema` | Standard JSON Schema-compatible schema | none | Validates runtime body input and supplies schema defaults. Cannot be combined with `body`. |
| `headers` | `Record<string, string>` | none | Static request headers. |
| `cookies` | `Record<string, string>` | none | Static request cookies. |
| `timeout` | `number` | `30000` | Request and response-body timeout in milliseconds. |
| `maxResponseBytes` | `number` | `5242880` | Maximum decoded response size. Explicit limits must not exceed 25 MiB. |
| `request` | `FetchSourceRequestOptions \| callback` | none | Adds headers, cookies, timeout, or `maxResponseBytes` at request time. The callback receives request metadata, the Selected Workspace Scope, Source key, and Workspace name. |
| `transform` | `(response) => output` | identity | Transforms parsed response data before ViteHub serializes it. |
| `cache` | `false \| { maxAge?: number }` | `false` | Controls Source response caching. |
| `materialize` | `build \| lazy \| none` | `lazy`, or `none` when sync is enabled | Controls when response content is written into the Workspace Store. |
| `probeKeys` | `string[]` | inferred from `workspacePath` | Overrides the known Source item keys. |
| `sync` | `boolean \| WorkspaceSourceSyncPolicy` | `false` | Allows explicit Workspace Source Sync. |

A plain object Source with `url` is inferred as Fetch. In that shorthand, `path` supplies the Workspace path; when neither `path` nor `workspacePath` is present, ViteHub derives a file path from a query-free URL. Use the explicit `fetch()` helper when request-only behavior is intentional.

## Resolve custom Sources

Use `custom({ files })` when a Custom Source knows its Workspace paths before it loads their content. The shorthand enumerates those paths without resolving content, and path-scoped materialization resolves only the requested file's content callback.

Invocation-aware resolution belongs to Source helpers and custom Source definitions, not to the Source Binding wrapper. Use resolver forms such as `fetch(resolver)` or the resolver accepted by the relevant helper, then add binding behavior such as `mount`, `cache`, or `sync` around the result.

```ts [server/workspaces/support.ts]
import { custom, defineWorkspace } from '@vite-hub/workspace'

const guideSlugs = ['getting-started', 'inventory-planning']

export default defineWorkspace({
  sources: {
    guides: custom({
      cache: { maxAge: 3600 },
      materialize: 'lazy',
      files: guideSlugs.map(slug => ({
        path: `${slug}.md`,
        async content() {
          const response = await fetch(`https://docs.example.com/${slug}.md`)
          if (!response.ok)
            throw new Error(`Failed to load ${slug}: ${response.status}`)
          return await response.text()
        },
      })),
    }),
  },
})
```

ViteHub infers each file's media type from its path unless the descriptor provides `mediaType`. Use a full Custom Source with `getKeys()` and `getItem()` when retrieval needs behavior beyond a fixed file list.

Custom Sources can read existing materialized Workspace files through `ctx.workspaceFiles`. Use this when a Source needs previous generated output, such as a sync report or cached asset metadata, while producing the next materialized files. The view is read-only and does not expose Workspace Stores, provider adapters, snapshots, diffs, or Source materialization.

Sources can resolve their origin and mount for one invocation from trusted runtime context. Use this when the same Source key needs a narrower origin after Access selects a Workspace Scope.

```ts
declare global {
  interface ViteHubWorkspaceSourceResolutionContextMap {
    channel: { meta?: { customer?: string } }
  }
}

github(({ channel, invocation }) => {
  const scope = invocation.context.get<{ customers: string[] }>('support.customerScope')
  const customer = channel?.meta?.customer ?? scope?.customers[0]
  if (!customer)
    return false

  return {
    repo: 'quiverdk/ingestion',
    root: `dbt/${customer}`,
    mount: `ingestion/${customer}`,
  }
})
```

The resolver receives registered invocation context values directly and through `invocation.context`. Register application values through `ViteHubWorkspaceSourceResolutionContextMap`; the Agent package registers `channel` automatically. The resolver reads trusted Agent Invocation Context Values and the selected Workspace Scope, not model output. `access()` still controls authorization, and its selected scope must grant the Source key or Workspace path. ViteHub fingerprints options that affect scope so Source caches don't reuse data across scopes.

Resolved Sources are evaluated at invocation time and default to lazy materialization. A resolver can return a narrowed GitHub `repo`, `root`, and `mount` without also declaring build-time materialization or cache options; the resolved fingerprint includes the Selected Workspace Scope so one scope cannot reuse another scope's source data.
