# @vite-hub/bundle

Bundle reports for ViteHub apps. After a production build, one command tells you, or your Agent, how big the client and the server are, how much code loads at startup, and why each package is in the output.

```ts
// vite.config.ts
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ bundle: true })],
})
```

In Nuxt 5, set `vitehub: { bundle: true }` in `nuxt.config.ts`.

```sh
vite build                         # or nuxt build
vitehub bundle                     # client and server size, startup size, largest groups
vitehub bundle --json              # the full report
vitehub bundle why @libsql/client  # the import chain from the entry to the package
vitehub bundle why /docs/kv         # what a first visit to this page loads (Nuxt)
```

The commands read `.vitehub/bundle/` and need no dev server. Development builds are not measured.

## What the report says

- **Client and server.** Bytes and gzip bytes of the JavaScript that the build wrote, and the files that load at startup: the entries and every file that they import statically. On the server, startup code runs before the first request. Client startup combines all page entries, counting shared files once; a single page can load less.
- **Groups.** Each module counts toward one group: a ViteHub package (`@vite-hub/agent`, `vite-hub/console`), a framework package (`nitro`, `h3`, `vue`), a dependency, an app folder (`server/api`), or generated code (`.vitehub`, `#nitro/virtual`). A module gets its share of the bytes of the file it is in, so the groups add up to the file sizes.
- **Why.** The shortest import chain from an entry to a package, a file, or a group.
- **Routes.** In a Nuxt app, what the browser loads on a first visit to each page route: the startup files, and the files of the route's layout and pages with every file that they import statically, plus their CSS. Files that the page loads later with `import()` do not count. `why /docs/kv` finds the route that renders the path and lists its files and the largest modules that it adds.

The report joins the build environments. In Nuxt 5, Nitro bundles the SSR output, so the server part shows the SSR modules inside it instead of one large file.

## How it works

`hubBundle()` is a Vite plugin. In `writeBundle` it reads Rolldown's output chunks, `chunk.modules[id].renderedLength`, and `getModuleInfo()`, and writes `.vitehub/bundle/<environment>.json`. When Nitro bundles on its own, as in Nuxt 5, the plugin's Nitro module adds the same reader to Nitro's `build:config`. A new build removes the files of older builds.

Each Vite build command starts a fresh report. All environments of a Vite builder share a build ID, and `vite-hub/nuxt` starts one session for Nuxt's Vite and Nitro phases. Custom coordinators that run phases in separate processes must pass the same fresh `buildId` to `hubBundle({ buildId })` in every phase; independent commands do not join reports left on disk.

`vite-hub/nuxt` reads the pages and layouts that Nuxt resolves (`app.pages`, `app.layouts`) and passes them to `hubBundle().api.setRoutes()`. The client report stores each route with its component modules, the static imports of each output file, and the CSS files, so reading the report needs no Nuxt. A layout is known when `definePageMeta` sets a static `layout`; otherwise the route uses `default`.

Static route aliases share the canonical route's files and bytes. Lookup uses Vue Router's matcher and Nuxt's `router.options.sensitive` and `strict` settings. Nuxt 5 defaults to case-sensitive matching. A custom `app/router.options.ts` file, including one from a layer or module, can replace routes or matching settings at runtime. In that case route estimates are unavailable: the CLI says why, and `client.routesUnavailable` stores the reason in JSON. This also applies to custom router options files that only change other settings. Bundle totals and module explanations remain available.

Read the report in code:

```ts
import { explainBundleRouteTarget, explainBundleTarget, readBundleReport } from "@vite-hub/bundle"

const report = readBundleReport(process.cwd())
const why = explainBundleTarget(process.cwd(), "zod")
const page = explainBundleRouteTarget(process.cwd(), "/docs/kv")
```
