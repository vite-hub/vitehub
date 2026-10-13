---
title: Source configuration
description: Configure built-in Source loaders, cache policy, and custom loader definitions.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

Configure the built-in loaders, or define a custom loader with `defineSource()`.

## Source loader options

| Loader | Key options | Behavior |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source Context root. `workspacePath` sets the Source key. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Uses the `file()` contract with `text/markdown` as the default media type. Unlike `file()`, it requires an options object. |
| `glob(options)` | `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Expands local files with `tinyglobby`. Keys are relative to `cwd`. `prefix` prepends a path to each item. `keyCache: false` disables the cached key snapshot. Symbolic links are off by default. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `ignore`, `cache`. | Retrieves repository content. `ref` defaults to the repository default branch. `auth` can be a token string or a trusted callback. |
| `mcpResources(options)` | `server`, `include`, `ignore`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` can be a client, a client config with an `http` or `sse` transport, or a resolver. |
| `defineSource(loader)` | A loader with `name`, `getKeys`, and `getItem`. | Defines custom retrieval behavior with inferred item types. |

Use `sourceIgnores` for reusable ignore patterns. Workspace GitHub Sources apply `sourceIgnores.defaults` automatically. Pass `ignore: false` to opt out, or pass more patterns to extend the defaults.

`glob()` caches its key listing per Source Reader. Opening a new reader gets a
fresh listing without replacing an existing reader's keys. File content and
metadata still come from the current file system. With `keyCache: false`, each
listing refreshes the keys; item and metadata reads reuse the latest listing and
refresh it when the requested key is missing.

### Cache options

`github()`, `mcpResources()`, and custom Sources can expose a cache policy. `false` disables it. GitHub applies the policy to its own ref, archive, and metadata caches. Workspace uses the same policy to decide whether materialized Source content is fresh.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses this value when it decides whether materialized Source content is still fresh. |

## Source object contract

`defineSource()` accepts a loader definition. Every loader has `name`, `getKeys()`, and `getItem()`. It does not accept reader objects or reader factories.

```ts
import { createSource, defineSource } from 'vite-hub/source'

const articles = defineSource({
  name: 'articles',
  async getKeys() {
    return ['article_123' as const]
  },
  async getItem(key: `article_${string}`) {
    return { key, data: { title: 'Source API' }, metadata: { version: 1 } }
  },
})

const reader = createSource(articles)
const article = await reader.get('article_123')
article.data.title
article.metadata.version
```

`SourceReader<typeof articles>`, `SourceKey<typeof articles>`, `SourceData<typeof articles>`, and `SourceMetadata<typeof articles>` derive their types from the definition. A record reader has no typed `read()` or `list()` methods. File loaders return `FileSource`, whose `SourceFile` items always have `content`. Custom loaders that guarantee `content` receive these file methods too.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Loader name used in errors and metadata. |
| `cache` | `false` or `SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for origin state. |
| `resolveRevision(ctx)` | `function` | Optional. Pins a mutable origin ref to one revision before any other operation. |
| `prepare(ctx)` | `function` | Optional prefetch or validation hook. |
| `getKeys(ctx)` | `function` | Required. Returns all addressable Source keys. |
| `getItem(key, ctx)` | `function` | Required. Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional bulk item reader. |
| `getMeta(key, ctx)` | `function` | Optional metadata reader. |

`resolveRevision()` and `prepare()` each run at most once for every `createSource()` or `useSource()` reader, before its first operation. The resolved revision is added to the shared context. Revision-aware loaders use it for preparation, keys, items, and metadata. Loaders without revision support can observe origin changes. Create another reader to resolve a new revision. `getItems()` lets a consumer load all items in one call. `getMeta()` can return origin metadata without loading content.

### Source context

`createSource()` accepts a partial context and supplies the full `SourceContext` to each loader method. `useSource(name, context?)` uses the same reader lifecycle.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Base project directory. |
| `sourceRootDir` | `string` | None | Optional Source-specific root. Built-in local file loaders fall back to `rootDir` when it is absent. |
| `source` | `string` | Definition name, or registered name for `useSource()` | Identifies the active Source. |
| `workspace` | `string` | None | Identifies the Workspace that consumes the Source. |
| `abortSignal` | `AbortSignal` | None | Cancels in-flight work. Custom loaders must forward it to fetches and other abortable operations. |
| `revision` | `SourceRevision` | None | The revision pinned by `resolveRevision()` for every later operation in this reader or Workspace lifecycle. |
