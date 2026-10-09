---
title: Content server API
description: Read documents, navigation, search results, and cache entries from the Content runtime.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineContent` from `vite-hub/content` | Define the Content runtime that ViteHub serves from `server/content.ts`. |
| `contentSource` from `vite-hub/content` | Adapt one Source and set Comark options such as `prefix` and `schema`. |
| `defineContentHandler` from `vite-hub/content` | Adapt a Content runtime to an H3 or Nitro route in another server. |
| `createContentClient`, `defineContentClientPlugin` from `vite-hub/content/client` | Use or extend the typed Comark Content client. |
| `comark-content/database/*`, `comark-content/plugins/*`, `comark-content/sources/*` | Comark databases, parser and search plugins, and native Comark Sources. |

Libraries can install `@vite-hub/content` and use the matching `@vite-hub/content` and `@vite-hub/content/client` imports.

## Runtime API

`defineContent()` returns a Comark Content hub with ViteHub adapters for named Sources.

| Method | Behavior |
| --- | --- |
| `content.get(path)` | Returns one parsed document by public path, such as `/guide`. |
| `content.list(names?)` | Lists documents. Accepts one instance name or an array. |
| `content.navigation(names?)` | Builds one navigation tree across the selected instances. |
| `content.search(names, query, options?)` | Runs full-text search across the named instances. Requires the `sqlite-full-text-search` plugin. |
| `content.init()` | Loads and parses every instance. |
| `content.getSource(name?)` | Returns the Comark Source for one instance. Defaults to `default`. |
| `content.handler(request)` | Answers a Web `Request`. The generated route calls it through `defineContentHandler()`. |

```ts
await content.get('/guide')
await content.navigation(['docs'])
await content.search(['docs'], 'runtime')
```

Methods that plugins add, such as SQL queries, stay available on the returned runtime.

### Cache

Comark Content owns parsed document cache entries. ViteHub routes each cache call to the instance that owns it.

| Method | Behavior |
| --- | --- |
| `content.cache.refresh(name)` | Reloads one instance from its Source. |
| `content.cache.invalidate(key)`, `content.cache.expire(key)` | Invalidates or expires one cache entry. Keys start with the instance name, such as `docs:guide/index.md`. |
| `content.cache.get(key)`, `content.cache.set(key, value)` | Reads or writes one cache entry. |
| `content.cache.keys(name?)`, `content.cache.clear(name?)` | Lists or clears entries for one instance or all instances. |
| `content.cache.snapshot(name, options?)` | Refreshes one instance and builds a Comark cache artifact. |

### Client

`createContentClient()` calls `/api/content` by default. Pass `instances` to search specific named Sources. Client plugins, such as `comark-content/plugins/sqlite-full-text-search/client`, add methods that match server plugins.
