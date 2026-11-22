# @vite-hub/source decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## The public JSON of the access error sets `data: undefined` explicitly

`toJSON` in `packages/source/src/client.ts`.

**Context:** Nostics requires the `data` key, and filling it would put diagnostic data into public responses.

**Decision:** The public JSON of the access error sets `data: undefined` explicitly.

**Consequences:** Setting `data` to the diagnostic data exposes internal details in public JSON; omitting the key breaks the Nostics shape.

## normalizeQuery() lets server code filter on any field path; only the HTTP querySchema in array() limits callers to declared filters

`normalizeQuery` in `packages/source/src/core/array-collection.ts`.

**Context:** Server code is trusted, while HTTP queries are validated by parseQuery() through the querySchema that rejects undeclared keys.

**Decision:** normalizeQuery() lets server code filter on any field path; only the HTTP querySchema in array() limits callers to declared filters.

**Consequences:** Moving the declared-filter check out of querySchema, or assuming normalizeQuery restricts fields, lets HTTP callers filter on undeclared fields.

## Collection cursors accept only canonical unpadded base64url and reject bad characters, padding and lengths before calling atob()

`decodeBase64Url` in `packages/source/src/core/collection-cursor.ts`.

**Context:** Host decoders differ in how leniently they accept malformed base64, so cursor validity would depend on the host.

**Decision:** Collection cursors accept only canonical unpadded base64url and reject bad characters, padding and lengths before calling atob().

**Consequences:** Relaxing the check lets one cursor decode on one host and fail on another, and accepts non-canonical aliases of the same cursor.

## Cross-copy state uses `Symbol.for` keys (on the reader object, or on `globalThis` for the Source registry)

`untransformedTableRows`, `registryKey` in `packages/source/src/core/collection.ts`, `packages/source/src/core/registry.ts`.

**Context:** In development the generated registry plugin and the app can load two copies of the module, and object spreads plus separate package entry points must keep the raw-rows guard.

**Decision:** Cross-copy state uses `Symbol.for` keys (on the reader object, or on `globalThis` for the Source registry).

**Consequences:** A module-local Symbol or Map splits the registry and drops the raw-rows guard across copies, so Sources go missing or raw table rows lose their public-route protection.

## A repeated query value is typed as a tuple of two or more strings, not `string[]`

`RepeatedQueryValues` in `packages/source/src/core/collection.ts`.

**Context:** H3 and requestQuery() give no value as undefined, one value as a string, and only repeated values as an array, so an array always has at least two items.

**Decision:** A repeated query value is typed as a tuple of two or more strings, not `string[]`.

**Consequences:** Typing it as `string[]` makes the ambiguous-array-key check accept query schemas that cannot receive what the route actually parses.

## Published diagnostic codes stay stable, and retired codes (SOURCE_R0007, R0010, R0019, R0020) are never reused

`sourceErrorDiagnostics` in `packages/source/src/error-diagnostics.ts`.

**Context:** Codes are public: docs pages, catalogs and user searches point at them, and one code names one failure site.

**Decision:** Published diagnostic codes stay stable, and retired codes (SOURCE_R0007, R0010, R0019, R0020) are never reused.

**Consequences:** Renumbering or reusing a retired code sends users to docs for a different failure.

## The bundled glob() module inflates with node:zlib/node:buffer when getBuiltinModule provides them, else with an atob loop and DecompressionStream

`renderBundledGlob` in `packages/source/src/internal/bundle-glob.ts`.

**Context:** On Node, zlib decodes about 5 times faster than atob() plus DecompressionStream (nodejs/performance#134), and Uint8Array.from() with a map takes about 75 ms for 1.5 MB.

**Decision:** The bundled glob() module inflates with node:zlib/node:buffer when getBuiltinModule provides them, else with an atob loop and DecompressionStream.

**Consequences:** Replacing either path with the simpler form makes Content cold starts measurably slower.

## Each bundled file is returned with slice(), a copy, not a view of the shared unpacked buffer

`renderBundledGlob` in `packages/source/src/internal/bundle-glob.ts`.

**Context:** All files share one unpacked buffer.

**Decision:** Each bundled file is returned with slice(), a copy, not a view of the shared unpacked buffer.

**Consequences:** Switching to subarray() lets a caller that mutates one file corrupt the bytes of other files.

## The build disables a Collection route only for a literal `route: false` in the options of an exported `const` initialized by exactly one call to ViteHub's own `defineCollection` (imported from a ViteHub Source entry or auto-imported); every other form writes the route and defineCollectionHandler() answers 404 at request time

`callsViteHubFactory`, `findCollectionDefinitionCall`, `collectionRouteDisabled`, `defineCollectionHandler` in `packages/source/src/internal/collection-discovery.ts`, `packages/source/src/server.ts`.

**Context:** Static discovery cannot run the module, and a spread, computed key, conditional, local factory, `let`/`var` or later assignment can change the route at run time, so only the unambiguous form is trusted.

**Decision:** The build disables a Collection route only for a literal `route: false` in the options of an exported `const` initialized by exactly one call to ViteHub's own `defineCollection` (imported from a ViteHub Source entry or auto-imported); every other form writes the route and defineCollectionHandler() answers 404 at request time.

**Consequences:** Trusting a non-literal or non-ViteHub form would let the build drop or keep a route that does not match what the module returns, so a Collection can become routed without its access check or a private route can 404 wrongly.

## Collection files are parsed as TypeScript whatever their extension

`findCollectionDefinitionCall` in `packages/source/src/internal/collection-discovery.ts`.

**Context:** Generated or hand-written `.mjs`/`.js` Collection files can contain TypeScript syntax, for example from generated types.

**Decision:** Collection files are parsed as TypeScript whatever their extension.

**Consequences:** Parsing by the real extension fails on those files and loses route discovery.

## The Content types writer close hook is idempotent (`closing ??=`)

`startWriter` in `packages/source/src/internal/content-types-writer.ts`.

**Context:** Nuxt calls the Nitro close hook itself, so it runs again after the CLI has already closed Nitro.

**Decision:** The Content types writer close hook is idempotent (`closing ??=`).

**Consequences:** Removing the guard closes the server twice and rejects with an already-closed error on shutdown.

## Optional peers (`@vite-hub/forge`, `@modelcontextprotocol/sdk`, `vite`) are imported dynamically on first use, and the Forge import stays inside the try block

`loadForge`, `loadMcpSchemas`, `inspectContentEntry` in `packages/source/src/sources/github/client.ts`, `packages/source/src/sources/mcp-resources.ts`, `packages/source/src/vite.ts`.

**Context:** Apps that do not install the peer must still import the module, and esbuild keeps an import inside try for run time instead of failing the build.

**Decision:** Optional peers (`@vite-hub/forge`, `@modelcontextprotocol/sdk`, `vite`) are imported dynamically on first use, and the Forge import stays inside the try block.

**Consequences:** A static import or moving the Forge import out of the try breaks apps and builds that do not install the optional peer.

## A GitHub 422 counts as a missing ref, like 404

`missingAsUndefined` in `packages/source/src/sources/github/client.ts`.

**Context:** GitHub answers 422, not 404, for an unknown commit SHA.

**Decision:** A GitHub 422 counts as a missing ref, like 404.

**Consequences:** Treating 422 as an error makes an unknown SHA throw instead of resolving as missing.

## A pull request counts as merged when `merged === true` or `merged_at` is set

`pullRequest` in `packages/source/src/sources/github/client.ts`.

**Context:** The `/commits/<sha>/pulls` list has `merged_at` but no `merged` field.

**Decision:** A pull request counts as merged when `merged === true` or `merged_at` is set.

**Consequences:** Reading only `merged` reports every merged pull request from the list endpoint as unmerged.

## commit() reads `/commits/<sha>` to confirm a SHA exists instead of trusting contents.resolveRef()

`commit` in `packages/source/src/sources/github/client.ts`.

**Context:** Forge contents.resolveRef() returns a full SHA without any request, so it never proves the commit exists.

**Decision:** commit() reads `/commits/<sha>` to confirm a SHA exists instead of trusting contents.resolveRef().

**Consequences:** Using resolveRef() alone lets a nonexistent SHA pass as a valid revision.

## On 403/429 a GitHub read retries the archive anonymously through codeload

`archive`, `shouldResolveMainFallback` in `packages/source/src/sources/github/client.ts`, `packages/source/src/sources/github/index.ts`.

**Context:** An authenticated archive counts against the API rate limit, while an anonymous public archive comes from codeload, which has no API limit.

**Decision:** On 403/429 a GitHub read retries the archive anonymously through codeload.

**Consequences:** Removing the anonymous fallback makes rate-limited public repositories fail to load.

## For more than one commit, changedPaths() unions the files of each commit (up to 20 commits) instead of trusting the compare file list

`changedPaths` in `packages/source/src/sources/github/client.ts`.

**Context:** The compare files are the net change, so a file that one commit edits and a later commit reverts is missing.

**Decision:** For more than one commit, changedPaths() unions the files of each commit (up to 20 commits) instead of trusting the compare file list.

**Consequences:** Using only the compare list misses touched-then-reverted files, so their cached pages are not refreshed.

## latest() asks GitHub GraphQL for 150 files per request and halves the batch on 502/504 down to 20 files

`historyBatch`, `latest` in `packages/source/src/sources/github/index.ts`.

**Context:** GitHub answers 150 files in about 4 seconds and stops a GraphQL request at 10 seconds with 502.

**Decision:** latest() asks GitHub GraphQL for 150 files per request and halves the batch on 502/504 down to 20 files.

**Consequences:** Larger batches or no split make latest() fail on big repositories; smaller batches multiply requests.

## pullsAt() falls back to the open pull requests of the base repository when the commit lists none

`pullsAt` in `packages/source/src/sources/github/index.ts`.

**Context:** The base repository does not list a fork pull request for the fork's commits, but its open pull request list does.

**Decision:** pullsAt() falls back to the open pull requests of the base repository when the commit lists none.

**Consequences:** Removing the fallback makes `/pr` previews and lookups miss every fork pull request.

## glob() caches keys per SourceContext in a WeakMap

`glob` in `packages/source/src/sources/glob.ts`.

**Context:** A reader keeps one context for its preparation and all its reads (core/reader.ts), so the cache lives exactly as long as one reader.

**Decision:** glob() caches keys per SourceContext in a WeakMap.

**Consequences:** Keying the cache globally or per call makes readers share stale listings or re-scan the disk on every read.

## An owned MCP client is created outside the abortable wrapper; only connect and the callback are abortable

`withMcpClient` in `packages/source/src/sources/mcp-resources.ts`.

**Context:** If creation were interruptible, an abort could leave a created client that the function never closes.

**Decision:** An owned MCP client is created outside the abortable wrapper; only connect and the callback are abortable.

**Consequences:** Wrapping createMcpClient in abortable leaks transports and clients on abort.

## MCP resources apply an explicit ignore before any content read, and an extensionless resource is skipped before the read only by a global catch-all (`**` or `**/*`); exact matches wait until the MIME type fixes the key

`isIgnoredBeforeContentRead`, `createEntries` in `packages/source/src/sources/mcp-resources.ts`.

**Context:** The key of an extensionless resource depends on the content MIME type, and an ignored resource must not cause a remote read or surface a provider error.

**Decision:** MCP resources apply an explicit ignore before any content read, and an extensionless resource is skipped before the read only by a global catch-all (`**` or `**/*`); exact matches wait until the MIME type fixes the key.

**Consequences:** Reading before ignoring leaks remote reads and provider errors for excluded resources, and matching provisional keys exactly ignores or keeps the wrong resource.

## The prewarm Queue name is a copied string literal that must equal `contentPrewarmQueueName` of @vite-hub/content

`contentPrewarmQueue` in `packages/source/src/vite.ts`.

**Context:** The Source plugin must not import Content.

**Decision:** The prewarm Queue name is a copied string literal that must equal `contentPrewarmQueueName` of @vite-hub/content.

**Consequences:** Changing either copy alone makes push prewarm jobs go to a Queue nobody consumes.

## Generated Source, Content and Auth entries load lazily on first request or first read, not at server start

`mergeGeneratedSourceNitroConfig`, `writeSourceArtifacts`, `writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** Content routes import the Markdown parser and all Sources, and a bundled glob() can be megabytes, so eager loading would add that cost to every cold start.

**Decision:** Generated Source, Content and Auth entries load lazily on first request or first read, not at server start.

**Consequences:** Making these entries eager moves the full Content, Markdown and Source cost into server startup on every host.

## The Source registry plugin runs at `position: "start"`, before other Nitro plugins

`writeSourceArtifacts` in `packages/source/src/vite.ts`.

**Context:** Other plugin callbacks read Sources by name, which needs the registration; creating a reader alone does not.

**Decision:** The Source registry plugin runs at `position: "start"`, before other Nitro plugins.

**Consequences:** Moving the registry later makes plugins that read a Source by name fail to find it.

## When static inspection cannot read the defineContent options, it enables every SEO handler (and marks MCP as unknown)

`inspectContentOptions` in `packages/source/src/vite.ts`.

**Context:** A spread or other dynamic shape can enable SEO at run time, and the build cannot run the module.

**Decision:** When static inspection cannot read the defineContent options, it enables every SEO handler (and marks MCP as unknown).

**Consequences:** Treating unreadable options as disabled silently omits valid routes.

## Enabling `llms` also enables `markdown`

`inspectContentOptions` in `packages/source/src/vite.ts`.

**Context:** The llms files link to the `.md` page copies.

**Decision:** Enabling `llms` also enables `markdown`.

**Consequences:** Decoupling them makes llms.txt link to `.md` URLs that 404.

## The Content preview plugin is always generated, even for apps without collections, as a small entry that keeps the Content runtime lazy

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** Cookie previews and signed Source links must bypass Nitro's cache.

**Decision:** The Content preview plugin is always generated, even for apps without collections, as a small entry that keeps the Content runtime lazy.

**Consequences:** Generating it only with collections serves cached published pages to preview cookies and signed links.

## vite-hub/content/sqlite is loaded by a Nitro plugin at server start, and the plugin returns the import so it is not tree-shaken

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** A Cloudflare Worker compiles WebAssembly only during startup, which SQLite WASM needs, while Content itself loads on first request.

**Decision:** vite-hub/content/sqlite is loaded by a Nitro plugin at server start, and the plugin returns the import so it is not tree-shaken.

**Consequences:** Loading SQLite lazily with Content fails on Cloudflare Workers.

## The build writes an empty `.vitehub/types/content.d.ts` when none exists

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** `.vitehub/types.d.ts` references every file in `.vitehub/types`, and the real file is written only by the first development server.

**Decision:** The build writes an empty `.vitehub/types/content.d.ts` when none exists.

**Consequences:** Removing the placeholder breaks typechecks and builds that run before any dev server.

## Content previews (`/tree`, `/blob`, `/pr`) are a Nitro plugin, not a route, and set the app base in runtime config to the preview prefix

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** The previewed page must run with its production path through every app route, and Nuxt links and data requests must stay under the prefix.

**Decision:** Content previews (`/tree`, `/blob`, `/pr`) are a Nitro plugin, not a route, and set the app base in runtime config to the preview prefix.

**Consequences:** A route-based preview would conflict with app routes and render the page outside its real route tree, and dropping the base override sends Nuxt links out of the preview.

## When Content MCP config is unknown, /mcp is generated as pass-through middleware instead of a route

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** A disabled Content MCP server must not reserve /mcp, so the app's own MCP handler keeps answering there.

**Decision:** When Content MCP config is unknown, /mcp is generated as pass-through middleware instead of a route.

**Consequences:** Registering a route for unknown config shadows or collides with the app's /mcp handler.

## `seo: { markdown }` copies are served by middleware that loads at server start, while server/content.ts loads only on the first Markdown or HTML request

`writeContentArtifact` in `packages/source/src/vite.ts`.

**Context:** `<page>.md` URLs match no Nitro route pattern, and the middleware must read the response of later handlers to produce the Markdown 404.

**Decision:** `seo: { markdown }` copies are served by middleware that loads at server start, while server/content.ts loads only on the first Markdown or HTML request.

**Consequences:** Turning it into a route or a lazy handler breaks `.md` URLs or the Markdown 404 detection.

## The generated app base comes from the VITEHUB_APP_BASE_URL config key when set, not from Vite `base`

`applicationBaseURL` in `packages/source/src/vite.ts`.

**Context:** Nuxt serves Vite assets from `/_nuxt/`, so its Vite base is not the app base; vite-hub/nuxt passes the real one.

**Decision:** The generated app base comes from the VITEHUB_APP_BASE_URL config key when set, not from Vite `base`.

**Consequences:** Reading Vite `base` makes every Nuxt app use `/_nuxt/` as its app base.

## In a legacy `build.ssr` build, glob() hints go to the stored resolved config

`hubSource` in `packages/source/src/vite.ts`.

**Context:** The legacy SSR build hook has no Vite environment to report through.

**Decision:** In a legacy `build.ssr` build, glob() hints go to the stored resolved config.

**Consequences:** Dropping resolvedConfig loses the non-literal glob() hints in legacy SSR builds.

## The Source plugin refreshes Auth discovery itself during preparation

`hubSource.configResolved` in `packages/source/src/vite.ts`.

**Context:** Auth owns discovery, and relying on watcher listener order can leave generated routes with stale Auth imports.

**Decision:** The Source plugin refreshes Auth discovery itself during preparation.

**Consequences:** Removing the explicit refresh brings back stale Auth imports after file changes, depending on listener order.

## Nitro routes are reconciled in configResolved, after Vite resolves root and server directories

`hubSource.configResolved` in `packages/source/src/vite.ts`.

**Context:** Nitro initializes before post-enforced config hooks, so the routes added there are based on unresolved directories.

**Decision:** Nitro routes are reconciled in configResolved, after Vite resolves root and server directories.

**Consequences:** Doing it only in the config hook registers routes from the wrong directories.

## The conditional Content MCP middleware matches the full prefixed URL, including the app base

`does not reserve /mcp for unknown %s, and serves it when enabled` in `packages/source/test/content-mcp-generation.test.ts`.

**Context:** Nitro prefixes route-scoped middleware and handlers with the base without rewriting the request URL.

**Decision:** The conditional Content MCP middleware matches the full prefixed URL, including the app base.

**Consequences:** Matching a base-less path makes the Content MCP middleware miss requests in apps with a non-root base.

## A Drizzle table Collection (rawRows) gets a route only with authorize, and a public one needs transform

`does not give a table Collection without authorize a route` in `packages/source/test/drizzle.test.ts`.

**Context:** A users table with password hashes was once served to anyone at /api/users.

**Decision:** A Drizzle table Collection (rawRows) gets a route only with authorize, and a public one needs transform.

**Consequences:** Relaxing the rawRows access rule can expose whole database rows, including secrets, on a public route.
