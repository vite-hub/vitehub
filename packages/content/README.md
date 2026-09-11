# @vite-hub/content

ViteHub content integration for Comark Content 0.4.

Pass Comark `ContentSource` objects directly. A single source becomes a named `default` instance. Named sources are composed with Comark's `contentHub()`.

```ts
import { defineContent } from "@vite-hub/content"
import fs from "comark-content/sources/fs"

export const content = defineContent({
  sources: {
    docs: fs("./docs"),
    blog: fs("./blog"),
  },
})
```

Use Comark's source packages for filesystem, GitHub, unstorage, or snapshot content. `defineContentHandler()` adapts the Comark Web handler to H3 events.
