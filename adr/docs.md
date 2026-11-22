# Docs decisions

## Keep the docs base when a site moves from dir to sources

`packages/docs/src/nuxt.ts`.

**Context:** `sources` defaults to `/docs`, but `dir` can default to `/` when it has no `docs/` folder.

**Decision:** Warn when the default base contains no pages, and let the site select its base explicitly.

**Consequences:** A site whose old base was `/` can keep its navigation by setting `base: '/'` when it migrates.

## Read Content Source pages from memory during template generation

`writeSources` and `readPage` in `packages/docs/src/nuxt.ts`.

**Context:** `nuxi build` clears the build directory after modules load and generates templates before `build:before` writes the source pages again.

**Decision:** Keep the source Markdown by source and file when writing pages to disk. Use it when reading pages for templates.

**Consequences:** Source-backed templates do not depend on generated files being present during template generation.

## `playground` and `learn` pages fill the docs shell with a workspace

`DocsPage`, `DocsPlayground` and `DocsLearn` in `packages/docs/runtime/app/components/`, `docs-layout` in `packages/docs/runtime/app/middleware/docs-layout.ts`, and `setupDocsRunnable` in `packages/docs/src/runnable/nuxt.ts`.

**Context:** A workspace needs the full width and the data that the build writes for its page. A Content preview of a new such page has no data yet.

**Decision:** A page with `layout: playground` or `layout: learn` gets the docs shell, and its sidebar starts as a narrow strip. Such pages turn on the runnable build even without `runnable` options. The build writes one module per page, and `#docs/workspaces` loads it by page path, so a page loads only its own files and a site without such pages gets none. A page without data shows as an article. The schema rejects a layout-only field on another layout. `src/runnable/document.ts` runs in the build and in the browser, so it imports nothing from Node.

**Consequences:** A change must keep each page's data in its own module, and must not import Node modules into `document.ts`.

## Lessons and examples share snapshots, and a lesson runs requests in the workspace

`buildTutorialSnapshots` in `packages/docs/src/runnable/snapshots.ts`, and `DocsLearn`, `DocsLearnCodePre` and `DocsPlayground` in `packages/docs/runtime/app/components/`.

**Context:** A WebContainer needs cross-origin isolation, and Comments needs a ViteHub Database. Both come from `vite-hub/nuxt`, which the app installs. The preview frame can send only GET requests.

**Decision:** The build snapshots `node_modules` of each fixture, and the browser caches the parts under one name per set of dependencies, so a lesson and an example with the same dependencies share one copy and the runner switches between them without a new boot. A fixture without dependencies has no snapshot. A code block that sends a request runs it in the workspace through a script in `node_modules`, so the file tree and the zip never list it, and shows the response under the block. The steps of a lesson can come from another docs page, so the prose has one source. A lesson shows the Vite tab of each framework tabs block, since the workspace is a Vite app. `?step=` and `?example=` open a step or an example, and older `?template=` links still open.

**Consequences:** A change to the cache name or the request script path breaks shared snapshots or lists internal files to the reader.
