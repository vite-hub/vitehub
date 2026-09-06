# @vite-hub/content

`@vite-hub/content` runs Comark Content with ViteHub Source definitions, registered names, explicit readers, or native Comark Sources.

## Install

```sh
pnpm add @vite-hub/content @vite-hub/source comark-content
```

## Define content

```ts
import { defineContent } from "@vite-hub/content"
import { glob } from "@vite-hub/source/glob"

export const content = defineContent({
  sources: {
    docs: glob({ include: "docs/**/*.md" }),
  },
})

await content.get("/guide")
await content.navigation(["docs"])
```

Pass Source definitions directly. No registration is required. `defineContent()` gives each adapted Source load a separate adapter that keeps its selected Reader until all parser reads finish. Definitions, registered names, and reader factories select a new Reader for each load. Overlapping refreshes, fresh snapshots, and fresh document reads keep their selected revisions.

`contentSource(definition, { prefix, schema })` adapts a definition with Comark options. A direct adapter selects a Reader when `keys()` starts an enumeration. Its later `getItem()` calls use that Reader until the next enumeration. Use `defineContent()` to isolate overlapping loads. `defineContent({ source: definition })` also accepts a single Source.

An explicit reader keeps its selected revision across refreshes. Readers only need an `items()` method. Raw media uses the newest successfully enumerated Source revision. Native Comark Sources pass through unchanged.

The combined `vite-hub` framework discovers `server/content.ts` and serves its exported `content` instance at `/api/content/**`.

Use `createContentClient` from `@vite-hub/content/client` in client code.
