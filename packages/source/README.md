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
import { defineSources, file, github, glob, registerSources, useSource } from "@vite-hub/source"

registerSources(defineSources({
  docs: glob({ include: "docs/**/*.md" }),
  readme: file("README.md"),
  upstream: github({ repo: "vite-hub/vitehub" }),
}))

const docs = useSource("docs", { rootDir: process.cwd() })
const keys = await docs.keys()
const first = await docs.read(keys[0]!)
```

## Errors

Built-in loaders throw `SourceError` with a stable `code` and JSON-safe `details`. `toJSON()` excludes the original `cause`, stack, credentials, request URLs, absolute paths, and provider response bodies; the protected server runtime can still inspect `error.cause` for diagnostics.

```ts
import { SourceError } from "@vite-hub/source"

throw new SourceError("[vitehub] custom source request failed.", {
  code: "SOURCE_PROVIDER_REQUEST_FAILED",
  details: { operation: "read", provider: "custom" },
  cause,
})
```

`SourceNotFoundError` and `SourcePathError` preserve their specialized class identity for registry and path failures. Configuration mistakes such as a missing `file()` path remain `TypeError` because they are programmer errors rather than Source runtime failures.

## Used by

[`@vite-hub/workspace`](../workspace/README.md) materializes Source output into workspace files. Use this package directly when you only need typed source loading and not a workspace file tree.

Built on [tinyglobby](https://github.com/SuperchupuDev/tinyglobby), [picomatch](https://github.com/micromatch/picomatch), and [mrmime](https://github.com/lukeed/mrmime).

Learn more at [vitehub.dev](https://vitehub.dev).
