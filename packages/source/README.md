# @vite-hub/source

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Sources" src="https://img.shields.io/badge/Source-typed%20retrieval-0f766e?style=flat-square">
</p>

`@vite-hub/source` loads files, globs, markdown, GitHub content, or custom data before something else places it in a workspace.

## Install

```sh
pnpm add @vite-hub/source
```

## Minimal API

```ts
// server/utils/sources.ts
import { defineSources, glob, markdown, registerSources, useSource } from "@vite-hub/source"

registerSources(defineSources({
  docs: glob({ cwd: "docs", include: "**/*.md" }),
  readme: markdown({ path: "README.md", workspacePath: "README.md" }),
}))

const docs = useSource("docs", { rootDir: process.cwd() })
const keys = await docs.keys()
const first = await docs.read(keys[0]!)
```

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
