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
```

The commands read `.vitehub/bundle/` and need no dev server. Development builds are not measured.

## What the report says

- **Client and server.** Bytes and gzip bytes of the JavaScript that the build wrote, and the files that load at startup: the entry and every file that it imports statically. On the server, startup code runs before the first request. On the client, it loads with the first page.
- **Groups.** Each module counts toward one group: a ViteHub package (`@vite-hub/agent`, `vite-hub/console`), a framework package (`nitro`, `h3`, `vue`), a dependency, an app folder (`server/api`), or generated code (`.vitehub`, `#nitro/virtual`). A module gets its share of the bytes of the file it is in, so the groups add up to the file sizes.
- **Why.** The shortest import chain from an entry to a package, a file, or a group.

The report joins the build environments. In Nuxt 5, Nitro bundles the SSR output, so the server part shows the SSR modules inside it instead of one large file.

## How it works

`hubBundle()` is a Vite plugin. In `writeBundle` it reads Rolldown's output chunks, `chunk.modules[id].renderedLength`, and `getModuleInfo()`, and writes `.vitehub/bundle/<environment>.json`. When Nitro bundles on its own, as in Nuxt 5, the plugin's Nitro module adds the same reader to Nitro's `build:config`. A new build removes the files of older builds.

Read the report in code:

```ts
import { explainBundleTarget, readBundleReport } from "@vite-hub/bundle"

const report = readBundleReport(process.cwd())
const why = explainBundleTarget(process.cwd(), "zod")
```
