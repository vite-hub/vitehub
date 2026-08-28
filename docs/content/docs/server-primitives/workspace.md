---
title: Workspace
description: Build persistent file-tree state with rules, Source Bindings, snapshots, diffs, and sessions.
navigation.order: 7
navigation.group: Files and execution
icon: i-lucide-folder-git-2
---

Use Workspace when server code or an Agent needs a persistent file tree. A Workspace can read and write files, sync Sources, create snapshots and diffs, and open transactional sessions. You control which operations each caller receives.

[Blob](/docs/server-primitives/blob) stores objects without file-tree behavior. [Source](/docs/server-primitives/source) retrieves read-only content. Workspace can store its files in Blob and bind content from Sources.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/workspace
```

### Configure

```ts [vite.config.ts]
import { hubWorkspace } from '@vite-hub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkspace()],
})
```

### Start using it

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({ include: ['docs/**/*.md'] }),
  },
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkspace` from `@vite-hub/workspace` | Declare a Workspace Definition. |
| `useWorkspace` from `@vite-hub/workspace` or `@vite-hub/workspace/runtime` | Read, write, diff, snapshot, sync, or start sessions for a Workspace. |
| `file`, `glob`, `github`, `markdown`, `mcpResources`, `fetch`, `custom` from `@vite-hub/workspace` | Declare Workspace Source Bindings. |
| `createWorkspaceTools` from `@vite-hub/workspace` or `@vite-hub/workspace/ai` | Build AI SDK tools from Workspace access. |
| Source resolution and request helpers from `@vite-hub/workspace/runtime` | Integrate resolved Workspace Sources into runtime facades. |
| `defineWorkspaceFileHandler`, `readWorkspaceFileResponse` from `@vite-hub/workspace/server` | Serve Workspace files from H3 routes. |
| `hubWorkspace` from `@vite-hub/workspace/vite` | Register Workspace discovery, generated types, assets, and runtime wiring. |
| `@vite-hub/workspace/loader`, `@vite-hub/workspace/publish`, `@vite-hub/workspace/test` | Add loaders and publishers, or create test Workspaces. |

Workspace definition, Source Binding, rule, hook, store, sync, facade, and session types are exported from `@vite-hub/workspace`. Source resolution runtime types are exported from `@vite-hub/workspace/runtime`.

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
| Local | `{ provider: 'local', root?: string }` | Filesystem-backed Workspace Store. Used by default in development and on hosts without a more specific match. |
| Memory | `{ provider: 'memory' }` | Test or ephemeral runtime storage. |
| Cloudflare Artifacts | `{ provider: 'cloudflare-artifacts', binding?, namespace?, repo?, repoPrefix?, branch? }` | Opt-in, versioned Git storage. Defaults: binding `WORKSPACE_ARTIFACTS`, namespace `vitehub`, repo prefix `vitehub-workspace-`. |
| Vercel Blob | `{ provider: 'vercel-blob', token?, prefix?, access? }` | Blob-backed storage. Defaults: prefix `.vitehub/workspaces`, access `private`; the token can come from `BLOB_READ_WRITE_TOKEN`. |
| GitHub | `{ provider: 'github', repo?, repository?, branch?, root?, token? }` | Repository-backed storage. Defaults: branch `main`, root `.vitehub/workspaces/<workspace>`. |
| Custom | `WorkspaceStore` | Implement the Workspace Store contract directly. |

Without a `store`, development uses Local. Production uses Memory on Cloudflare, Vercel Blob when `BLOB_READ_WRITE_TOKEN` exists, Memory on Vercel without that token, and Local on other hosts. You must select Cloudflare Artifacts or GitHub yourself.

### Cloudflare Artifacts

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

Cloudflare Artifacts is currently a closed beta and is not available on Workers Free, so the Cloudflare default remains the ephemeral `memory` Store. The Worker adapter clones into isolate memory; use it for deliberately small Workspaces rather than assuming the Artifacts repository limit is also a usable Worker checkout size. For large repositories in a sandbox, container, or VM, use Cloudflare's [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/) directly.

Artifacts repositories are private Git storage. Use [Blob](/docs/server-primitives/blob) with R2 or another provider when an Agent needs a public delivery URL.

## Define a workspace

Create a Workspace Definition when the app needs durable file-tree behavior.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, glob, github } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    docs: glob({
      cwd: '.',
      include: ['README.md', 'docs/**/*.md'],
    }),
    handbook: github({
      repo: 'acme/handbook',
      ref: 'main',
      root: 'support',
      mount: 'handbook',
      materialize: 'lazy',
    }),
  },
  rules: {
    '/**': { write: false },
    '/drafts/**': { write: true, mediaType: 'text/markdown' },
  },
})
```

Source keys identify named origins inside the Workspace Source Map. A Source-Backed Path is read-only unless Workspace rules and runtime access allow writes elsewhere in the file tree.

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

Instruction text reads scalar bindings with `{{ workspace.<name> }}` and file-backed bindings with `@workspace.<name>`. Only keys declared in `bindings` are available; ViteHub does not expose arbitrary Workspace files to Instruction Composition. See [Agent instructions](/docs/agents/instructions#insert-workspace-bindings).

## Source Binding options

Workspace Source Bindings can wrap Source Package loaders and add Workspace behavior.

| Option | Type | Description |
| --- | --- | --- |
| `mount` | `WorkspaceSourceMount` | Where retrieved items appear in the Workspace file tree. Accepts a path string or Mount options. |
| `materialize` | `WorkspaceMaterializeMode` | Build-time, lazy, or disabled materialization. Values: `build`, `lazy`, `none`. |
| `cache` | `false or WorkspaceCacheOptions` | Source cache policy. Use `false` to disable caching or `{ maxAge }` to set a TTL. |
| `validate` | `WorkspaceValidateMode` | Request validation mode for API-backed Sources. Use `false` or `request`. |
| `sync` | `WorkspaceSourceSyncConfig` | Enables explicit Workspace Source Sync. Accepts `true`, `false`, or a sync policy. |
| `probeKeys` | `string[]` | Known Source item keys used to check bundled-source completeness and intersect path-scoped access without enumerating the whole Source. File-shaped helpers infer this when possible. |

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

## Use it at runtime

Read files from server code with `useWorkspace()`.

```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')
  return workspace.fs.glob('**/*.md')
})
```

Request write access only at the call site that needs mutation.

```ts [server/api/drafts.post.ts]
import { useWorkspace } from '@vite-hub/workspace'

export default defineEventHandler(async (event) => {
  const workspace = useWorkspace('docs', { mode: 'write' })
  const body = await readBody<{ text: string }>(event)

  await workspace.fs.writeFile('drafts/summary.md', body.text, {
    mediaType: 'text/markdown',
  })

  return workspace.diff()
})
```

## Runtime facade

`useWorkspace(name)` returns read access. `useWorkspace(name, { mode: 'write' })` returns write access.

| Surface | Methods |
| --- | --- |
| `workspace.fs` read mode | `readFile`, `stat`, `exists`, `list`, `glob`, `search` |
| `workspace.fs` write mode | read methods plus `writeFile`, `appendFile`, `mkdir`, `rm`, `movePath`, `copyPath` |
| writable facade | `diff`, `snapshot`, `history.checkpoint`, `history.rebase`, `materializeSources`, `sync`, `startSession`, optional Store metadata methods `getMeta` and `setMeta`, and `tools` |
| tools | default tools, `tools.inspect(options)`, `tools.write(options)`, `tools.none()` |

### Runtime method options

| Method | Options | Behavior |
| --- | --- | --- |
| `readFile(path, options?)` | `encoding?: 'utf8' \| 'binary'` | Defaults to UTF-8 text; binary reads return `Uint8Array`. |
| `writeFile(path, content, options?)` | `mediaType?`, `metadata?` | Writes string or binary content with optional file metadata. |
| `list(path?, options?)` | `recursive?: boolean` | Lists direct children or the complete subtree. |
| `glob(pattern, options?)` | `cwd?: string` | Matches one pattern or an array relative to an optional Workspace directory. |
| `search(query)` | `pattern`, `cwd?`, `paths?`, `regex?`, `caseSensitive?`, `limit?` | Searches text. Defaults to a case-insensitive literal pattern with a limit of `100`. |
| `mkdir(path, options?)` | `recursive?: boolean` | Creates a Workspace directory. |
| `rm(path, options?)` | `recursive?: boolean`, `force?: boolean` | Removes a file or directory under the active write policy. |
| `movePath(from, to, options?)` | `overwrite?: boolean` | Moves a path. Existing destinations fail unless `overwrite` is enabled. |
| `copyPath(from, to, options?)` | `overwrite?: boolean` | Copies a path. Existing destinations fail unless `overwrite` is enabled. |
| `snapshot(options?)` | `name?: string` | Captures the current Workspace tree with an optional snapshot name. |
| `history.rebase(options?)` | `takeRemote?: string[]` | Reloads a remote Store while preserving staged paths. A listed path takes its remote version only when both sides changed; any other overlapping change remains a conflict. |
| `diff(options?)` | `from?: WorkspaceSnapshot` | Compares the current tree with the supplied snapshot or the Store baseline. |
| `materializeSources(options?)` | `abortSignal?`, `onProgress?`, `sources?`, `path?` | Materializes every Source or a selected Source/path subset, with cancellation and progress reporting. |
| `getMeta(key)` / `setMeta(key, value)` | Store-defined | Reads or writes optional Workspace Store metadata when the configured Store implements it. |

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
| `sync.stale` | `keep \| remove` | `keep` | Keeps files no longer returned by the Source, or removes them during reconciliation. |

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

Set `writeBack.exclude` to Workspace-relative paths owned by the runtime rather than the invocation. Excluded paths remain usable in the host tree, but their changes are omitted from `diff()` and `commit()` and their pre-Session state is restored by `close()`. Set `writeBack: false` when the runtime must remain writable but its changes must never be published. That mode disables `diff()` and `commit()` and restores the authoritative Workspace on close without first scanning the runtime tree. Read-only Agent Workspaces select it automatically. ViteHub always applies the same excluded-path behavior to `.agent-runs`, `.git`, and `.vitehub`. Integrations that already own a live materialized tree can set `attach: true`; the Session preserves pre-existing live edits, never rematerializes the whole tree, and rolls back only its own uncommitted changes on close.

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

## Connect Workspace to Agents

Workspace isn't automatically available to a model. Attach `workspaceShell()` when a model needs to inspect or edit files. Use `access()` when trusted invocation identity selects the Workspace Scope.

Read [Workspace and Sources](/docs/concepts/workspace-and-sources) for the mental model and [Workspace context](/docs/agents/workspace-context) for Agent-specific composition.

## Next steps

- Use direct retrieval through [Source](/docs/server-primitives/source).
- Add command inspection with [Shell](/docs/server-primitives/shell).
- Expose file access to models through [Official capabilities](/docs/capabilities/official-capabilities).
