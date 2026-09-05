# @vite-hub/content

`@vite-hub/content` runs Comark Content with native Comark Sources, registered ViteHub Sources, or explicit ViteHub Source Readers.

## Install

```sh
pnpm add @vite-hub/content @vite-hub/source comark-content
```

## Define content

```ts
import { defineContent } from "@vite-hub/content"

export const content = defineContent({
  sources: {
    docs: "docs",
  },
})

await content.get("/guide")
await content.navigation(["docs"])
```

`defineContent()` gives each adapted Source load a separate adapter that keeps its selected Reader until all parser reads finish. Registered Source names and Reader factories select a new Reader for each load. Explicit Readers stay fixed. Overlapping refreshes, fresh snapshots, and fresh document reads therefore keep their selected revisions. Raw media uses the newest successfully enumerated Source revision. Native Comark Sources pass through unchanged.

A direct `contentSource()` adapter selects a Reader when `keys()` starts an enumeration. Its later `getItem()` calls use that Reader until the next enumeration. Use `defineContent()` to isolate overlapping loads.

The combined `vite-hub` framework discovers `server/content.ts` and serves its exported `content` instance at `/api/content/**`.

Use `createContentClient` from `@vite-hub/content/client` in client code.
