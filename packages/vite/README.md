# @vite-hub/vite

`@vite-hub/vite` is the compatibility import for the canonical `vite-hub` framework package. It forwards the same `vitehub()` function and keeps existing Vite configuration source-compatible.

Install `vite-hub` directly alongside this compatibility package so generated framework imports resolve from your application root.

```ts
import { vitehub } from "@vite-hub/vite"
```

New applications should install `vite-hub` and import from its root instead:

```sh
pnpm remove @vite-hub/vite
pnpm add vite-hub
```

```ts
import { vitehub } from "vite-hub"
```

There are no `@vite-hub/vite/*` feature exports. Use `vite-hub/agent`, `vite-hub/env`, `vite-hub/workspace`, and the other deliberate framework subpaths for the one-dependency application experience, or install an `@vite-hub/*` owner package directly for advanced composition.
