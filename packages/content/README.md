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

Each Comark cache refresh creates a ViteHub Source Reader. Each load therefore reads one pinned origin revision. Native Comark Sources pass through unchanged.

The combined `vite-hub` framework discovers `server/content.ts` and serves its exported `content` instance at `/api/content/**`.

Use `createContentClient` from `@vite-hub/content/client` in client code.
