---
title: Source configuration
description: Configure the built-in Source loaders, their cache, and your own loaders.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

A loader reads one kind of origin, such as a GitHub repository. Use a built-in one, or write one with `defineSource()`.

## Source loader options

| Loader | Key options | Behavior |
| --- | --- | --- |
| `file(input)` | A path string, `{ path, workspacePath?, mediaType? }`, or inline `{ workspacePath, content, mediaType? }`. | Reads one file from the Source root. `workspacePath` sets the key. The returned Source has that key in `key`. A Workspace puts the file at this path unless the binding sets `mount`. |
| `markdown(options)` | `{ path, workspacePath?, mediaType? }` or inline `{ workspacePath, content, mediaType? }`. | Same as `file()`, with `text/markdown` as the default media type. It requires an options object. |
| `glob(pattern)`, `glob(options)` | A pattern such as `'content/docs/**/*.md'`, or `include`, `cwd`, `ignore`, `dot`, `followSymlinks`, `keyCache`, `prefix`. | Finds files with `tinyglobby`. Keys are relative to `cwd` (in a pattern, the folders before the first wildcard). `prefix` adds a path before each item. `keyCache: false` turns off the key cache. Symlinks are off by default. A build bundles the files ([Hosts without a file system](#hosts-without-a-file-system)). |
| `files(entries, options?)` | A record of path to content or a content loader, `base`, and `prefix`. | Serves files from memory. A loader runs on each read, so an `import.meta.glob()` record works. `base` is removed from each path, then a leading `./` is removed from the key. A build turns `glob()` into this. Needs no file system. |
| `github(options)` | `repo`, `ref`, `root`, `auth`, `include`, `ignore`, `cache`. | Reads repository content through [`forges`](https://forges.link). `ref` defaults to the default branch. `auth` is a token string or a trusted callback. Without `auth`, it reads Server Env `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`. `auth: false` uses no token. |
| `mcpResources(options)` | `server`, `include`, `ignore`, `path`, `request`, `cache`. | Reads MCP Resource content. `server` is a client, a client config with an `http` or `sse` transport, or a resolver. Install `@modelcontextprotocol/sdk` to use it. Agent apps already have it. |
| `defineSource(loader)` | A loader with `name`, `getKeys`, and `getItem`. | Defines your own loader, with inferred item types. |

`github()` reads only GitHub.com repositories, with `repo` as `owner/name`. It ignores `GH_TOKEN` and `GITHUB_TOKEN`, so in GitHub Actions set `VITEHUB_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. The token goes only to the GitHub API and the sparse Git fetch, never to the `codeload.github.com` redirect. Without a token, public archives come from `codeload.github.com`, outside the anonymous API limit.

`sourceIgnores` holds reusable ignore patterns. Workspace GitHub Sources apply `sourceIgnores.defaults`. `ignore: false` turns them off; more patterns extend them.

In `include` and `ignore`, `glob()` treats `/` and `\` as separators, also before wildcards: `"docs\\*.md"` means `"docs/*.md"`. Backslashes never escape. To match a literal character, use brackets: `[*]`, `[?]`, or `[[]`. For example, `"docs/file[[]1].md"` matches `docs/file[1].md`. The same patterns find and filter files.

`glob()` caches its key list per reader. A new reader gets a new list without changing other readers. Content and metadata always come from the current disk. With `keyCache: false`, each listing refreshes the keys, and item reads refresh the list when the key is missing.

### Hosts without a file system

Point `glob()` at your project files and deploy to any host:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source'

export default defineContent({
  sources: {
    docs: glob('content/docs/**/*.md'),
  },
})
```

Under `vite dev`, `glob()` reads from disk, so edits show at once. A server build lists the files with the same `ignore`, `dot`, and symlink rules, and replaces the call with [`files()`](#source-loader-options) holding their bytes, gzipped. The server inflates them on the first read, so a large folder costs little at startup. Cloudflare Workers, Netlify, Vercel, Deno Deploy, and Node then serve the same content. New files appear after the next build.

::warning
The build bundles a call only when its options are literals: a string, or an object of strings, booleans, and string arrays. With any other value, such as a variable, the call reads from disk at runtime and the build warns. Hosts without a file system will not find those files.
::

### Cache options

`github()`, `mcpResources()`, and your own loaders can set a cache policy. `false` turns it off. GitHub applies it to its ref, archive, and metadata caches.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAge` | `number` | Consumer default | Maximum cache age in seconds. Workspace uses it to decide if its copy of the Source content is still fresh. |

## Source object contract

`defineSource()` takes a loader with `name`, `getKeys()`, and `getItem()`. It does not take reader objects or reader factories.

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

`SourceReader<typeof articles>`, `SourceKey<typeof articles>`, `SourceData<typeof articles>`, and `SourceMetadata<typeof articles>` take their types from the definition. A record reader has no typed `read()` or `list()`. File loaders return `FileSource`, whose `SourceFile` items always have `content`. Your loaders that always return `content` get these file methods too.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Name used in errors and metadata. |
| `cache` | `false` or `SourceCacheOptions` | Optional cache policy. |
| `fingerprint` | `unknown` | Cache identity for the origin state. |
| `resolveRevision(ctx)` | `function` | Optional. Pins a changing origin ref to one revision before other operations. |
| `prepare(ctx)` | `function` | Optional hook to prefetch or validate. |
| `getKeys(ctx)` | `function` | Required. Returns all keys. |
| `getItem(key, ctx)` | `function` | Required. Returns a `SourceItem` for one key. |
| `getItems(ctx)` | `function` | Optional. Reads all items at once. |
| `getMeta(key, ctx)` | `function` | Optional. Reads metadata. |

- `resolveRevision()` and `prepare()` run at most once per `createSource()` or `useSource()` reader, before its first operation.
- The revision goes into the shared context, and loaders that support revisions use it for later calls. Other loaders can see origin changes. A new reader resolves a new revision.
- `getItems()` loads all items in one call. `getMeta()` returns metadata without loading content.

### Source context

`createSource()` and `useSource(name, context?)` take a partial context and pass the full `SourceContext` to each loader method.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `rootDir` | `string` | `process.cwd()` | Project folder. |
| `sourceRootDir` | `string` | None | Optional root for this Source. Built-in file loaders use `rootDir` when it is unset. |
| `source` | `string` | Definition name, or registered name for `useSource()` | Names the active Source. |
| `workspace` | `string` | None | Names the Workspace that uses the Source. |
| `abortSignal` | `AbortSignal` | None | Cancels running work. Your loaders must pass it to fetches and other operations that can stop. |
| `revision` | `SourceRevision` | None | The revision that `resolveRevision()` pinned for later operations of this reader or Workspace. |
