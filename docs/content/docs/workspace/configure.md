---
title: Workspace configuration
description: Configure the Workspace Vite integration, Store providers, Workspace Definitions, and Source Bindings.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Choose where a Workspace keeps files, what each Workspace Definition (a `defineWorkspace()` file) holds, and where Sources appear.

## Configure the Vite Integration

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { workspace: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ workspace: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ workspace: true })],
})
```
:::
::

`workspace` takes `true` or an object with these options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workspace` | `boolean` or `WorkspaceOptions` | disabled | `true` or an object turns Workspace on in `vitehub()`. `false` keeps it off. |
| `root` | `string` | `.vitehub/workspaces` | Runtime Workspace root directory. |
| `projectRoot` | `string` | ViteHub project root | Project root that server-side discovery starts from. |
| `assets` | `WorkspaceOptions['assets']` | package default | Which Workspace assets the build writes. `false`, `true`, or a list of asset paths. |
| `store` | `WorkspaceStoreOptions` | inferred from dev mode, host, and environment | Store for definitions that do not choose one. |

## Store providers

| Store | Configure with | Nuance |
| --- | --- | --- |
| Local | `{ provider: 'local', root?: string, locks?: 'filesystem' \| 'process' }` | Files on disk. Default in development and on hosts with no better match. |
| Memory | `{ provider: 'memory' }` | Temporary storage for tests or short-lived runtimes. |
| Cloudflare Artifacts | `{ provider: 'cloudflare-artifacts', binding?, namespace?, repo?, repoPrefix?, branch? }` | Opt-in, versioned Git storage. Defaults: binding `WORKSPACE_ARTIFACTS`, namespace `vitehub`, repo prefix `vitehub-workspace-`. |
| Vercel Blob | `{ provider: 'vercel-blob', token?, prefix?, access? }` | Files live under `_vitehub/workspaces/<workspace>/`. `prefix`, or `VITEHUB_WORKSPACE_BLOB_PREFIX`, adds a namespace below `_vitehub/workspaces/` (letters, numbers, underscores, dashes, single slashes). The Console Blob section hides these files by default. Access defaults to `private`. On Vercel, it uses OIDC when the project has `BLOB_STORE_ID`. Elsewhere, it uses `BLOB_READ_WRITE_TOKEN`. |
| GitHub | `{ provider: 'github', repo?, repository?, branch?, root?, token?, refs?, database? }` | Files in a repository, with branches as history refs. Defaults: branch `main`, root `.vitehub/workspaces/<workspace>`. See [GitHub Store](#github-store). |
| Custom | `WorkspaceStore` | Your own implementation of the Store contract. |
| Blob + Database | `createBlobDatabaseWorkspaceStore({ blob, database, workspace, prefix? })` | Folder history that works on any host. Pass the returned Store to a Workspace Definition. |

Vercel Blob keeps file bytes and JSON attributes in separate objects. In one process, writes and removals on the same path run one at a time across Store instances, including failed-write recovery. Readers can see writes in progress.

::warning
This adapter has no distributed transactions. When processes or hosts share a Workspace, coordinate their access yourself. For atomic publication across replicas, use the Blob + Database Store.
::

A [GitHub Store](#github-store) signs in with a GitHub App when `VITEHUB_GITHUB_APP_ID` is set, else with the token in `VITEHUB_GITHUB_TOKEN` or `FORGES_GITHUB_TOKEN`. Only `VITEHUB_WORKSPACE_GITHUB_REPOSITORY`, `VITEHUB_WORKSPACE_GITHUB_BRANCH`, and `VITEHUB_WORKSPACE_GITHUB_ROOT` set its location.

In one isolate, GitHub Stores and history views cache blob bytes by sha, across repositories:

- Parallel reads with the same repository and credentials share one request. A failed request does not affect readers of another repository or token.
- The cache holds up to 32 MiB, removes the oldest entries first, and skips blobs over 4 MiB.
- New isolates, and reads after removal, fetch the blob from GitHub again. You can retry failed reads.

GitHub Stores also keep other answers, so a read asks GitHub only for what changed:

- A branch head is one request. The Store keeps it for 5 seconds, then asks again with its ETag. GitHub answers `304 Not Modified` when the branch did not move, and a `304` does not count against the GitHub rate limit.
- History pages, commits, and trees are read by commit sha, so their answers never change. Each Store keeps up to 12 MiB of them in memory. When the app enables [KV](/docs/kv) and uses Content, they also go to KV for 7 days, and a new isolate reads them there instead of from GitHub.
- `history.open(id).preload(paths)` reads many files of one commit from one archive of the commit instead of one request per file. It reads 8 files or fewer one by one. The archive of a commit also goes to KV.

Without a `store`, development uses Local. In production:

- Cloudflare uses Memory.
- Other hosts use Vercel Blob when `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` exists at build time.
- Without these variables, Vercel uses Memory and the other hosts use Local.

You must select Cloudflare Artifacts or GitHub yourself.

A Custom Store can add `removeEmptyDirectory(path)` for build Source cleanup. It must remove only an empty directory, keep files and missing paths, and reject a non-empty directory inside the Store mutation boundary. Without it, cleanup keeps generated directories. Local, Memory, and Cloudflare Artifacts have it.

Workspace paths cannot use `.git` at any depth or `.vitehub` at the root, in any case. ViteHub also rejects, on every host, NTFS stream suffixes such as `.vitehub::$INDEX_ALLOCATION`, trailing ASCII periods or spaces such as `.vitehub.`, and NTFS short names such as `git~1`.

### Blob + Database Store

This Store keeps fixed versions of a folder on any host that [Blob](/docs/blob/hosts) and [Database](/docs/database/hosts) support. Add its schema to a Database Definition, then generate and apply migrations with the Database integration.

```ts [server/databases/history/index.ts]
import { defineDatabase } from 'vite-hub/database'
import { workspaceHistorySchema } from 'vite-hub/workspace/blob-database'

export default defineDatabase({ name: 'history', schema: workspaceHistorySchema })
```

```ts [server/workspaces/drop.ts]
import { blob } from 'vite-hub/blob'
import { defineWorkspace } from 'vite-hub/workspace'
import { createBlobDatabaseWorkspaceStore } from 'vite-hub/workspace/blob-database'
import historyDatabase from '../databases/history/index'

export const dropStore = createBlobDatabaseWorkspaceStore({
  blob: blob.store('workspace-history'),
  database: historyDatabase,
  workspace: 'drop-123',
})

export default defineWorkspace({ store: dropStore })
```

`vite-hub/workspace/blob-database` also exports the constructor and schema. This subpath needs `drizzle-orm`. Configure the Blob store and Database connection in their own integrations. The Store does not create cloud resources or apply migrations at runtime.

Give each document or folder one stable workspace identity, and keep the identity and prefix across restarts. History objects live under `_vitehub/workspace-history/`, and `prefix: 'handbook'` puts them under `_vitehub/workspace-history/handbook/`. A prefix accepts letters, numbers, underscores, dashes, and single slashes. The Console Blob section hides `_vitehub/` paths by default. Each Store owns its Blob namespace, so never write its objects with another API.

Normal `fs` writes stage changes in the Store instance on the `main` ref. Call `snapshot()` or `history.checkpoint()` to commit them to `main`.

- A successful `history.commit()` to `main` replaces the staged tree with the new head. Commits to other refs leave it alone.
- A failed commit keeps staged changes.
- Staged changes are lost when the instance stops. Committed revisions persist.
- Other instances see committed heads. A staged checkpoint fails if its base head moved.

Keep work that must survive a restart, such as editor drafts, on its own ref. Commit each save with `history.commit({ ref: 'draft', ifHead, changes })`, then copy the chosen files to `published`. See [Refs](/docs/workspace/server-api#refs).

#### Upgrade an existing history Database

Named refs changed the schema:

- `workspace_history_workspaces` holds the deletion tombstone.
- `workspace_history_refs` has one row per Workspace and ref.
- Revisions record their `ref`, and the `published` column is now `committed`.

For new Databases, regenerate migrations. For a Database that already has history, run this SQL once so existing heads become `main`:

```sql
CREATE TABLE workspace_history_workspaces (workspace TEXT PRIMARY KEY NOT NULL, deleted INTEGER DEFAULT 0 NOT NULL);
INSERT INTO workspace_history_workspaces (workspace, deleted) SELECT workspace, deleted FROM workspace_history_refs;
ALTER TABLE workspace_history_refs RENAME TO workspace_history_refs_old;
CREATE TABLE workspace_history_refs (workspace TEXT NOT NULL, ref TEXT NOT NULL, head TEXT, sequence INTEGER DEFAULT 0 NOT NULL, PRIMARY KEY (workspace, ref));
INSERT INTO workspace_history_refs (workspace, ref, head, sequence) SELECT workspace, 'main', head, sequence FROM workspace_history_refs_old WHERE deleted = 0 AND head IS NOT NULL;
DROP TABLE workspace_history_refs_old;
ALTER TABLE workspace_history_revisions ADD COLUMN ref TEXT NOT NULL DEFAULT 'main';
ALTER TABLE workspace_history_revisions RENAME COLUMN published TO committed;
DROP INDEX workspace_history_timeline;
CREATE INDEX workspace_history_timeline ON workspace_history_revisions (workspace, ref, committed, sequence);
```

To delete the workspace and all its history, check authorization in your app, then call `await dropStore.delete()`. It marks the identity with a tombstone, then removes objects and catalog rows.

::warning
Deletion is permanent. A replacement workspace needs a new identity.
::

Retry `delete()` after a storage outage or once you stop an abandoned request. The tombstone blocks late commits, and a later sweep removes bytes from an interrupted upload.

The Store keeps every committed revision on every ref and has no pruning API. Failed or conflicting uploads can leave reusable objects, outside usage counts, until workspace deletion. See [host storage behavior](/docs/workspace/hosts#blob-database-history).

### GitHub Store

The GitHub Store keeps the Workspace in a repository. It reads and writes through the GitHub API, so it needs a token and a network. It supports [retained history](/docs/workspace/server-api): each branch is a ref, and each commit is a revision.

```ts [server/workspaces/docs.ts]
import { defineWorkspace } from 'vite-hub/workspace'

export default defineWorkspace({
  store: {
    provider: 'github',
    repository: 'onmax/docs',
    branch: 'main',
    root: '',
    refs: { published: 'main', draft: 'vitehub/content' },
  },
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `repository`, `repo` | `string` | `VITEHUB_WORKSPACE_GITHUB_REPOSITORY` | The repository, as `owner/name`. |
| `branch` | `string` | `VITEHUB_WORKSPACE_GITHUB_BRANCH`, else `main` | The branch of the Workspace files. |
| `root` | `string` | `VITEHUB_WORKSPACE_GITHUB_ROOT`, else `.vitehub/workspaces/<workspace>` | The folder in the repository. An empty string is the repository root. |
| `token` | `string` | A GitHub App from `VITEHUB_GITHUB_APP_ID`, then `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN` | The GitHub token. |
| `refs` | `{ published?: string, draft?: string }` | none | Branches for the history refs `published` and `draft`. |
| `database` | `unknown` | none | A value the Store target carries for code that keeps its own rows, such as the Drizzle Database of [Content sessions](/docs/content/editing-together). The Store ignores it. |

A GitHub App installation has a rate limit of its own, apart from the personal tokens that share one account. Set `VITEHUB_GITHUB_APP_ID` and `VITEHUB_GITHUB_PRIVATE_KEY` (or `VITEHUB_GITHUB_PRIVATE_KEY_PATH`), and install the App on the repository with contents and pull requests write access. `VITEHUB_GITHUB_INSTALLATION_ID` saves the lookup of the installation. The Store mints an installation token, keeps it until a minute before it expires, and commits as the App's bot.

The Store reads the repository and token at the first request, not at creation. A missing one throws `WORKSPACE_R0072` then, so a build that loads the Workspace Definition needs no token.

#### History on branches

- **Refs.** A history ref is a branch name. With `refs`, a call on `published` or `draft` uses the branch you named, and its revisions report the ref `published` or `draft`. A branch literally named `published` or `draft` is hidden while its alias points elsewhere. Naming the aliased branch itself, such as `main` for `published`, throws `WORKSPACE_R0071`. Use the alias, so rules on `published` always apply. Calls without `ref` use `main`.
- **First commit on a missing ref.** `commit({ ref, ifHead: null })` creates the branch from the `published` branch when `refs.published` is set, else from the repository's default branch. It copies all files of that branch, then applies your changes. `startFrom: <revision id>` starts from that revision instead, so a write builds on the exact files the caller read. A commit that changes nothing creates no branch.
- **Compare and swap.** ViteHub checks `ifHead` and `ifHeads` against the GitHub branch heads right before the commit. A stale value throws `WORKSPACE_CONFLICT`. GitHub updates one branch at a time, so another branch in `ifHeads` can still change between the check and the commit.
- **Commit metadata.** `message` is the commit message. `metadata` goes in its last line as `Vitehub-Metadata: {...}` (one line of JSON). `list`, `head`, `refs`, and `open` read it back and return the message without that line. Only the last line counts. Revision author fields come from the commit, never from the metadata. A message with its own `Vitehub-Metadata:` line, a message over 16 KiB, or metadata over 64 KiB as JSON throws `WORKSPACE_R0073`. Commits made outside ViteHub have no metadata.
- **Digests.** File digests are Git blob shas, not SHA-256. `history.digest(bytes)` returns the Store's digest for those bytes, and revision views list it as `digest`. Compare digests only with that function.
- **Paths.** `history.list({ path })` returns only commits that changed that file or folder.
- **Head cache.** `history.head()` caches a branch head for 5 seconds. A commit through the same Store instance updates it at once. Another writer's commit shows within 5 seconds.

#### Limits

- GitHub rate limits apply to every request. A revision view reads the whole tree of its commit.
- With the repository root as `root`, revisions include every repository file. Limit writes with `rules`: `{ '**': { write: false } }` denies all writes, and a more specific rule such as `'content/**/*.md': { write: true }` allows one folder.
- The Store does not create pull requests. [GitHub store](/docs/cms/configure#github-store) shows what the CMS adds on top.

### Local path locks

Local Stores lock each path before they read or write it. The default, `locks: 'filesystem'`, keeps lock markers in `.vitehub/locks` inside the root, so processes that share the root stay in sync.

Set `locks: 'process'` when one process owns the root, such as a throwaway checkout for one worker. The same per-path locks then live in memory, with no lock directory, no marker polling, and parallel listing. A waiting writer goes before readers that arrive after it. Process locks do not protect the root from other processes.

### Git checkout roots

Set `ignore: 'git'` when the Local Store root is a Git checkout. Listings, snapshots, and diffs then skip `.git` and every path Git ignores, such as `node_modules` and build output. The Store asks Git on each listing, so `.gitignore` changes apply at once. The host needs Git.

## Workspace Definition options

`defineWorkspace()` takes these fields. The name comes from the file path, or from the package that [contributes the Workspace](#contribute-workspace-definitions-from-a-package).

| Option | Type | Description |
| --- | --- | --- |
| `commit` | `boolean \| string` | Commit all changes automatically, with an optional message. |
| `rootDir` | `string` | Source root used by loaders. |
| `sourceRootDir` | `string` | Folder that local Source helpers such as `file()` and `glob()` read from. For application `server/workspaces/<name>.ts` files, the default is the resolved project root. For flat files in Nuxt layers, `server/workspaces/<name>/config.ts` and Agent folders, the default is the file's folder, or its `workspace/` folder when present. |
| `store` | `WorkspaceStoreOptions` | Store for this Workspace. |
| `bindings` | `Record<string, WorkspaceInstructionBinding>` | Values that Agent instructions can read: `string`, `number`, `boolean`, `null`, or a file as `{ path: string }`. |
| `sources` | `Record<string, WorkspaceSourceInput>` | Source Bindings (where each Source appears). |
| `rules` | `WorkspaceRules` | Read, write, media type, max size, commit, and validation rules by path pattern. |
| `hooks` | `WorkspaceHooks` | Write lifecycle hooks. |
| `plugins` | `WorkspacePlugin[]` | Packaged rules and hooks. |
| `loaders` | `WorkspaceLoader[]` | Build-time or runtime loaders. |

Instructions read value bindings with `{{ data.workspace.<name> }}` and file bindings with `:insert{:markdown="data.workspace.<name>"}`. Only keys in `bindings` are available. Other Workspace files stay hidden from instructions. See [Agent instructions](/docs/agents/instructions#insert-workspace-bindings).

## Contribute Workspace Definitions from a package

A package can add a Workspace from its Vite plugin, so apps do not write `server/workspaces/<name>.ts` for it. Add `vitehub.workspaces` to the plugin object. Each entry has a `name` and a `definition` that points to the module and export of a `defineWorkspace()` result:

```ts [my-package/vite.ts]
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import type { WorkspaceContributingPlugin } from '@vite-hub/workspace/vite'

export function myPackage(): Plugin & WorkspaceContributingPlugin {
  return {
    name: 'my-package/vite',
    vitehub: {
      workspaces: () => [{
        name: 'content',
        definition: {
          module: fileURLToPath(new URL('./runtime/workspace.js', import.meta.url)),
          export: 'contentWorkspace',
        },
        reason: 'Stores CMS documents.',
      }],
    },
  }
}
```

```ts [my-package/runtime/workspace.ts]
import { defineWorkspace } from '@vite-hub/workspace'

export const contentWorkspace = defineWorkspace({ /* store, rules, plugins */ })
```

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Workspace name for `useWorkspace(name)`. |
| `definition.module` | `string` | Absolute file path, `file:` URL, or package specifier the app can import. Relative paths fail. |
| `definition.export` | `string` | Export with the Workspace Definition. Defaults to `default`. |
| `reason` | `string` | Optional. Why the package adds the Workspace. Shown in `vitehub inspect definitions` and the Console. |

`vitehub.workspaces` takes an array or a factory. The factory can be async and receives `{ root, projectRoot, serverDirs }`, where `root` is the Vite root. The Workspace plugin can read contributions before your `config` hook runs, so compute them in the factory. It runs once per discovery pass and must return the same result each time. ViteHub sorts contributions by name.

A contributed Workspace works like a discovered file. It appears in the generated Nitro registry, the `WorkspaceName` types, `vitehub inspect definitions`, and the Console Workspaces section. The build loads its definition for asset bundling and Cloudflare Artifacts. The definition must not set `name`.

Each Workspace name has one definition. A contribution that reuses a name fails the build with `WORKSPACE_B0003`, and the message names both sources or plugins. An invalid contribution fails with `WORKSPACE_B0004`. If the export is missing at runtime, the first `useWorkspace(name)` throws a `TypeError` that names the module, export, and plugin.

When another build step needs the same list, `collectWorkspaceContributions(plugins, context)` from `@vite-hub/workspace/vite` returns the validated contributions.

## Source Binding options

Bind a Source definition with `{ source, mount, materialize }`. You can reuse
the same definition for direct reads or Content:

```ts [server/sources/docs.ts]
import { glob } from 'vite-hub/source'

export const docs = glob({ cwd: 'docs', include: '**/*.md' })
```

```ts [server/workspaces/docs.ts] fragment
import { defineWorkspace } from 'vite-hub/workspace'
import { docs } from '../sources/docs'

export default defineWorkspace({
  sources: {
    docs: { source: docs, mount: 'docs', materialize: 'lazy' },
  },
})
```

The Source key `intro.md` appears at `docs/intro.md`. The Source fetches the
items. The binding decides where they appear, when they are copied in
(materialization), sync, and access rules. Pass the same `docs` definition to
`createSource(docs)` for direct reads or `defineContent({ source: docs })` for
parsed Content. Each consumer owns its reader lifecycle and revision.

For a definition used only in Workspace, the Workspace `file()`, `glob()`, and
other binding helpers still work. Standalone Source loaders use
`defineSource()` for custom retrieval. Workspace's `custom()` helper adds
binding behavior.

### Default mount

Without a `mount` path, ViteHub picks the mount from the Source kind. The
import does not change it:

- A file Source puts its one file at its own key. This applies to `file()` and
  `markdown()` from `vite-hub/workspace` or `vite-hub/source`, and to the
  `'README.md'` and `{ path }` shorthands. `readme: file('README.md')` appears
  at `README.md`.
- `fetch()` also puts its one file at its own path.
- Every other Source mounts under its binding key. `docs: glob({ ... })` puts
  the key `intro.md` at `docs/intro.md`.

Set `mount` to move a file Source, for example
`readme: { source: file('README.md'), mount: 'docs' }` puts it at
`docs/README.md`. A file Source in `vite-hub/source` has a `key` property, so
you can check the path in code.

For MCP Resources, install `@modelcontextprotocol/sdk` in your app. This applies
to both `mcpResources()` and inferred MCP Source Bindings. Agent apps already
have it. See [Source configuration](/docs/source/configure) for the loader options.

| Option | Type | Description |
| --- | --- | --- |
| `source` | `Source` | The Source definition to bind. Required in this form. |
| `mount` | `WorkspaceSourceMount` | Where items appear in the file tree. A path string or Mount options. |
| `materialize` | `WorkspaceMaterializeMode` | When items are copied in: `build`, `startup`, `lazy`, or `none`. Startup Sources also work through lazy reads, and `createWorkspacePreparation()` can prepare them. |
| `cache` | `false or WorkspaceCacheOptions` | `false` turns caching off. `{ maxAge }` sets a TTL. |
| `validate` | `WorkspaceValidateMode` | Request validation for API-backed Sources: `false` or `request`. |
| `sync` | `WorkspaceSourceSyncConfig` | Turns on explicit Source Sync: `true`, `false`, or a sync policy. |
| `skills` | `false` | Keeps the Skills in this Source out of a Provider Agent's skill roots. See [Give the provider its Skills](/docs/agents/agent-drivers#give-the-provider-its-skills). |
| `probeKeys` | `string[]` | Known item keys. ViteHub uses them to check that a bundled Source is complete and to match path-scoped access without listing the whole Source. File helpers infer them when possible. |

### Prepare startup Sources

Use `createWorkspacePreparation()` when a process must copy in required Sources before it reports ready:

```ts
import { createWorkspacePreparation } from 'vite-hub/workspace/runtime'

export const preparation = createWorkspacePreparation({
  retryDelayMs: 10_000,
  workspace: 'docs',
})

await preparation.start()
```

Without `sources`, it selects every Source with `materialize: 'startup'`. A failed attempt becomes error state you can inspect, and retries in the background.

- `response()` returns a non-cacheable JSON readiness response that hides internal errors.
- `stop()` cancels the active attempt and its retry timer.

The state is readiness for this process only. It is not an ongoing upstream health or liveness signal.

### Fetch Sources

`fetch(options)` declares a Source that reads one HTTP URL. With `workspacePath`, the response appears at one read-only path. Without it, the Source is request-only, for runtime Source request integrations. `fetch(resolver)` receives the Source Resolution Context of the current invocation and returns the same options, or `false`, `null`, or `undefined`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | required | Request URL. |
| `workspacePath` | `string` | none | Read-only path for the response. Without it, the Source is request-only. |
| `method` | `GET \| HEAD \| POST` | `GET` | Allowed HTTP method. GET and HEAD cannot declare a body. |
| `responseType` | `json \| text` | `json` | How the response is parsed and stored. |
| `query` | `Record<string, unknown>` | URL query | Static query values. Cannot be combined with `querySchema`. |
| `querySchema` | Standard JSON Schema-compatible schema | none | Validates runtime query input and fills schema defaults. Cannot be combined with `query`. |
| `body` | `unknown` | none | Static POST body. Cannot be combined with `bodySchema`. |
| `bodySchema` | Standard JSON Schema-compatible schema | none | Validates runtime body input and fills schema defaults. Cannot be combined with `body`. |
| `headers` | `Record<string, string>` | none | Static request headers. |
| `cookies` | `Record<string, string>` | none | Static request cookies. |
| `timeout` | `number` | `30000` | Request and response-body timeout in milliseconds. |
| `maxResponseBytes` | `number` | `5242880` | Maximum decoded response size. At most 25 MiB. |
| `request` | `FetchSourceRequestOptions \| callback` | none | Adds headers, cookies, timeout, or `maxResponseBytes` per request. The callback receives request metadata, the Selected Workspace Scope, Source key, and Workspace name. |
| `transform` | `(response) => output` | identity | Changes parsed data before ViteHub stores it. |
| `cache` | `false \| { maxAge?: number }` | `false` | Response caching. |
| `materialize` | `build \| lazy \| none` | `lazy`, or `none` with sync on | When the response is written to the Store. |
| `probeKeys` | `string[]` | inferred from `workspacePath` | Overrides the known Source item keys. |
| `sync` | `boolean \| WorkspaceSourceSyncPolicy` | `false` | Allows explicit Source Sync. |

A plain object Source with `url` counts as Fetch. In that form, `path` sets the Workspace path. Without `path` or `workspacePath`, ViteHub makes a file path from a URL with no query. For a request-only Source, use `fetch()`.

## Resolve custom Sources

Use `custom({ files })` when a Custom Source knows its paths before it loads content. It lists the paths without loading content, and a path-scoped read calls only that file's `content` callback.

Per-invocation resolution belongs in Source helpers and custom Source definitions, not in the binding. Use a resolver form such as `fetch(resolver)`, then add binding options such as `mount`, `cache`, or `sync` around it.

```ts [server/workspaces/support.ts]
import { custom, defineWorkspace } from 'vite-hub/workspace'

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

ViteHub infers each file's media type from its path unless the file sets `mediaType`. For more than a fixed file list, write a full Custom Source with `getKeys()` and `getItem()`.

A Custom Source can read files already in the Workspace through `ctx.workspaceFiles`, such as a previous sync report or cached asset metadata. The view is read-only. It does not expose Stores, provider adapters, snapshots, diffs, or materialization.

A Source can pick its origin and mount per invocation from trusted runtime context. Use this when one Source key needs a narrower origin after Access selects a Workspace Scope.

```ts [server/workspaces/support/config.ts]
import { defineWorkspace, github } from 'vite-hub/workspace'

declare global {
  interface ViteHubWorkspaceSourceResolutionContextMap {
    'support.customerScope': { customers: string[] }
  }
}

export default defineWorkspace({
  sources: {
    ingestion: github(({ invocation }) => {
      const customer = invocation.context.get('support.customerScope')?.customers[0]
      if (!customer)
        return false

      return {
        repo: 'quiverdk/ingestion',
        root: `dbt/${customer}`,
        mount: `ingestion/${customer}`,
      }
    }),
  },
})
```

The resolver gets registered context values directly and through `invocation.context`. Register your values in `ViteHubWorkspaceSourceResolutionContextMap`. The Agent package registers `channel` for you. The resolver reads trusted invocation context and the selected Workspace Scope, never model output.

`access()` still decides authorization, and its selected scope must grant the Source key or path. Resolved Sources run at invocation time and default to lazy materialization. A resolver can return a narrower GitHub `repo`, `root`, and `mount` without build or cache options. ViteHub fingerprints the options and selected scope, so scopes never share cached data.
