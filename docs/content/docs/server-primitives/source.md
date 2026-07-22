---
title: Source
description: Retrieve read-only files, records, and external resources through typed source loaders.
navigation.order: 8
icon: i-lucide-folder-input
---

Source owns typed retrieval from read-only origins. Use it when server code needs addressable content from files, globs, markdown, GitHub, MCP resources, or custom loaders without first modeling a persistent Workspace file tree.

Source does not own Workspace placement, Source Sync, Workspace rules, snapshots, or model-facing guidance. Workspace can consume Sources and decide where retrieved items appear in a Workspace File Tree; Agent Driver Instructions decide how model-backed Agents should use them.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/source
```

### Configure

```ts [server/sources.ts]
import { defineSources, file, registerSources } from '@vite-hub/source'

export const sources = defineSources({
  readme: file('README.md'),
})

registerSources(sources)
```

### Start using it

```ts [server/api/readme.get.ts]
import '../sources'
import { useSource } from '@vite-hub/source'

export default defineEventHandler(() => {
  return useSource('readme').read('README.md')
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `defineSource`, `defineSources` from `@vite-hub/source` | Type and return one Source or a named Source map. |
| `registerSource`, `registerSources`, `clearSources`, `getRegisteredSource` from `@vite-hub/source` | Manage the process-local Source registry. |
| `useSource` from `@vite-hub/source` | Read from a registered Source at runtime. |
| `file`, `glob`, `github`, `markdown`, `mcpResources`, `custom` from `@vite-hub/source` | Create built-in Source loaders. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Inspect registry, path, and loader failures by `SOURCE_*` code. |
| `@vite-hub/source/sources/*` subpaths | Import one loader directly when you want narrower dependencies. |

Source, Source Reader, Source Item, loader option, cache, search, and error types are exported from `@vite-hub/source`.

## Register Sources

Use `@vite-hub/source` when you want a direct retrieval registry.

```ts [server/sources.ts]
import { defineSources, file, github, registerSources } from '@vite-hub/source'

export const sources = defineSources({
  readme: file('README.md'),
  docs: github({
    repo: 'acme/docs',
    ref: 'main',
    root: 'docs',
    include: ['**/*.md'],
  }),
})

registerSources(sources)
```

Named Source Loader imports are the public authoring shape. Import the helpers you need directly.

Source has no discovery or Vite Integration by itself. Import the module that registers Sources before calling `useSource()` in a process.

## Source loader options

| Loader | Key options | Nuance |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source Context root. `workspacePath` controls the Source key. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Uses the `file()` contract with `text/markdown` as the default media type. Unlike `file()`, it requires an options object. |
| `glob(options)` | `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Expands local files with `tinyglobby`; `keyCache: false` refreshes keys on each read path. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `exclude`, `cache`. | Retrieves repository archive content. `auth` can be a token string or a trusted callback. |
| `mcpResources(options)` | `server`, `include`, `exclude`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` can be a client, client config, or resolver. |
| `custom(source)` | A `Source` object. | Use when the built-in loaders do not match the origin contract. |

### Cache options

`github()`, `mcpResources()`, and custom Sources can expose a cache policy; `false` disables it. GitHub applies the policy to its own ref, archive, and metadata caches. Workspace can also consume the same policy when it decides whether materialized Source content is fresh.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses this value when deciding whether materialized Source content is still fresh. |

## Source object contract

A custom `Source` implements the retrieval behavior directly.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Loader name used in errors and metadata. |
| `cache` | `false or SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for origin state. |
| `prepare(ctx)` | `function` | Optional prefetch or validation hook. |
| `getKeys(ctx)` | `function` | Returns all addressable Source keys. |
| `getItem(key, ctx)` | `function` | Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional bulk item reader. |
| `getMeta(key, ctx)` | `function` | Optional metadata reader. |
| `search(query, ctx)` | `function` | Optional Source search implementation. |
| `watch` | `unknown[]` | Optional watch descriptors for the consuming integration. Source does not start a watcher by itself. |

`getKeys()` and `getItem()` are required. `prepare()` runs at most once for each `useSource()` reader before its first operation. `getItems()` lets a consumer load all items in one call; `getMeta()` can return origin metadata without loading content.

### Source Context

The caller that owns the runtime boundary supplies `SourceContext` to every custom Source method.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` for `useSource()` | Base project directory. |
| `sourceRootDir` | `string` | None | Optional Source-specific root. Built-in local file loaders fall back to `rootDir` when it is absent. |
| `source` | `string` | Registered Source name | Identifies the active Source. |
| `workspace` | `string` | None | Identifies the consuming Workspace when one owns the call. |
| `abortSignal` | `AbortSignal` | None | Cancels in-flight work when the owning runtime supplies a signal. Custom loaders should forward it to fetches and other abortable operations. |

### Custom search

A custom `search(query, ctx)` returns `SourceSearchHit[]`. Workspace can call this hook when it searches Source-backed paths; `SourceReader` itself exposes keys, item reads, metadata, existence checks, and listing.

| Query field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | Text or regular-expression pattern to find. |
| `cwd` | `string` | No | Narrows search to a Source-relative directory. |
| `paths` | `string[]` | No | Restricts search to explicit Source paths. |
| `regex` | `boolean` | No | Interprets `pattern` as a regular expression. |
| `caseSensitive` | `boolean` | No | Enables case-sensitive matching. |
| `limit` | `number` | No | Caps the number of returned hits. |

| Result field | Type | Description |
| --- | --- | --- |
| `path` | `string` | Source-relative path containing the match. |
| `line` | `number` | Match line number. |
| `column` | `number` | Match column number. |
| `text` | `string` | Matching line or excerpt. |

## Use it at runtime

Read a Source by name with `useSource()`.

```ts [server/api/readme.get.ts]
import '../sources'
import { useSource } from '@vite-hub/source'

export default defineEventHandler(async () => {
  const readme = useSource('readme')

  return {
    text: await readme.read('README.md'),
  }
})
```

## Source Reader API

| Method | Returns |
| --- | --- |
| `source.keys()` | All Source keys. |
| `source.get(key)` | A `SourceItem` with content, data, media type, and metadata. |
| `source.read(key, options?)` | Text by default, or `Uint8Array` with `{ encoding: 'binary' }`. |
| `source.meta(key)` | Metadata for one key, when the loader supports it. |
| `source.exists(key)` | Whether a key exists. |
| `source.list(prefix?)` | Direct child files and directories below a prefix. |

```ts [server/api/docs.get.ts]
import '../sources'
import { useSource } from '@vite-hub/source'

export default defineEventHandler(async () => {
  const docs = useSource('docs')

  return {
    files: await docs.keys(),
    root: await docs.list(''),
  }
})
```

## Use Sources with Workspace

Use Workspace Source Bindings when retrieved content should appear inside a persistent Workspace file tree.

```ts [server/workspaces/docs.ts]
import { defineWorkspace, file, github } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: file('README.md'),
    docs: github({
      repo: 'acme/docs',
      root: 'docs',
      mount: 'docs',
      materialize: 'lazy',
    }),
  },
})
```

The Source Package owns retrieval. The Workspace Package owns Mount placement, Source-Backed Paths, Source Sync Policy, low-level Source Instruction metadata, and Workspace Store reconciliation.

## Provider output

`@vite-hub/source` is a retrieval primitive, not a Vite Integration. It does not generate host output, provider config, or discovered Definitions by itself.

Workspace and other consuming packages can wrap Sources in discovered Definitions, runtime registries, generated metadata, or Provider Output when they need placement, persistence, or deployment wiring.

## Production boundaries

Treat Sources as read-only retrieval boundaries. Secrets for private origins should come from Server Env or trusted callbacks, not from model-authored input.

Use Workspace when content needs durable sync, path-scoped rules, diffs, snapshots, or scoped agent visibility. Use Source directly when server code only needs to retrieve and inspect items.

## Next steps

- Learn the shared model in [Workspace and Sources](/docs/concepts/workspace-and-sources).
- Persist retrieved content through [Workspace](/docs/server-primitives/workspace).
- Expose visible Workspace content to agents through [Official capabilities](/docs/capabilities/official-capabilities).
