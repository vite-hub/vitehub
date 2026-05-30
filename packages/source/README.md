# @vite-hub/source

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Sources" src="https://img.shields.io/badge/Source-typed%20retrieval-0f766e?style=flat-square">
</p>

`@vite-hub/source` owns Source Definitions, the Source Registry, Source Paths, and Source Loaders. Use it when you need typed retrieval from files, globs, markdown, GitHub, or custom data without also owning Workspace file-tree placement.

## Install

```sh
pnpm add @vite-hub/source
```

## Minimal API

```ts
import {
  defineSources,
  glob,
  markdown,
  registerSources,
  useSource,
} from "@vite-hub/source"

registerSources(defineSources({
  docs: glob({ cwd: "docs", include: "**/*.md" }),
  readme: markdown({ path: "README.md", workspacePath: "README.md" }),
}))

const docs = useSource("docs", { rootDir: process.cwd() })
const keys = await docs.keys()
const first = await docs.read(keys[0]!)
```

## Entry points

- `@vite-hub/source`: Source Definition helpers, Source Registry helpers, built-in Source Loaders, errors, and types.
- `@vite-hub/source/sources`: built-in Source Loaders as a grouped subpath.
- `@vite-hub/source/sources/*`: individual loader modules for custom, file, GitHub, glob, and markdown sources.

Learn more at [vitehub.dev](https://vitehub.dev).
