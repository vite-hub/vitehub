---
title: Content configuration
description: Define Content Sources, plugins, and Comark options with defineContent(), select a database, and check definition limits.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Definition options

`defineContent(options)` accepts one Source or a map of named Sources. A single `source` becomes an instance named `default`. Named `sources` become one Comark instance each, composed with Comark's `contentHub()`.

| Option | Type | Description |
| --- | --- | --- |
| `source` | Content Source input | One Source. Cannot be combined with `sources`. |
| `sources` | `Record<string, ContentSourceInput>` | Named Sources. Each name becomes a Content instance. |
| `plugins` | Comark Content plugins | Applied to each instance. Markdown parsing is built in. Add `json()`, `yaml()`, `media()`, `sql-query`, or `sqlite-full-text-search` plugins when you need them. |
| Other Comark options | `cache`, `hooks`, `markdown`, `logger`, `onError`, `baseURL` | Forwarded to each Comark Content instance. ViteHub sets `basePath` to `/api/content`. |

Plugin options are evaluated when the runtime is created. Recreate or rebuild the runtime to change them.

### Source inputs

| Input | Behavior |
| --- | --- |
| Source definition, such as `glob()` or `defineSource()` | Opens a new Reader for each load. Overlapping refreshes, fresh snapshots, and fresh document reads keep their selected revisions. |
| Registered Source name | Opens `useSource(name)` for each load. |
| Reader factory `() => reader` | Calls the factory for each load. |
| Explicit reader with `items()` | Keeps its caller-owned lifecycle and selected revision across refreshes. |
| Native Comark Source, such as `comark-content/sources/fs` | Keeps its own loading behavior. |

Each item's public path comes from its `path`, or from its key. Items need `content` or `data`. ViteHub serializes structured `data` as JSON before Comark parses it.

Use `contentSource(input, { prefix, schema })` to set Comark options for one Source. A direct adapter selects a Reader when `keys()` starts an enumeration. Its later `getItem()` calls use that Reader until the next enumeration. Pass the adapter through `defineContent()` to isolate overlapping loads.

## Providers

Content has no hosted provider. Comark Content stores its query and search index in the database that you pass to a plugin.

| Database | Import | Use |
| --- | --- | --- |
| Node SQLite | `comark-content/database/sqlite-node` | Node runtimes with built-in SQLite. |
| SQLite WASM | `comark-content/database/sqlite-wasm` | Runtimes where Node SQLite is unavailable. |

The `vitehub()` Vite plugin generates the Content route for every preset. The Nuxt module installs the same behavior. Libraries that use owner packages get it from `hubSource()` in `@vite-hub/source/vite`. Each Source loader must also work on the host. For example, `glob()` reads the local file system at runtime.

## Limits

- Define either `source` or `sources`. Passing both throws.
- A project has one Content file. More than one `content.ts` (or `.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) across server directories fails route generation with `SOURCE_B0007`. The file must export `content`, or generation fails with `SOURCE_B0008`.
- Public paths must stay inside the Source root. ViteHub rejects absolute paths, `.` and `..` segments, Windows drive paths, and paths that start with `.git` or `.vitehub` (`CONTENT_R0001`).
- Two items with the same public path fail the load (`CONTENT_R0003`).
- An item without `content` or `data` fails to parse (`CONTENT_R0002`).
- Raw media uses the newest Source revision that finished enumeration.
- `defineContent()` uses `AsyncLocalStorage` from `node:async_hooks`. The runtime must provide it.
