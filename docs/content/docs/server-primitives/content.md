---
title: Content
---

# Content

ViteHub exposes Comark Content through a small H3 adapter. Content definitions use Comark's native `ContentSource` contract and source packages.

```ts [server/content.ts]
import { defineContent } from "vite-hub/content"
import fs from "comark-content/sources/fs"

export const content = defineContent({
  sources: {
    docs: fs("./docs"),
    blog: fs("./blog"),
  },
})
```

`defineContent()` creates a named Comark instance for a single `source`, or a Comark `contentHub()` for `sources`.

Use Comark's source packages for filesystem, GitHub, unstorage, and snapshots. Use `defineContentHandler()` only when mounting the Comark handler through an H3 event handler.
