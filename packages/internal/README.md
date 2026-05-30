# @vite-hub/internal

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="Private" src="https://img.shields.io/badge/Private-not%20published-b91c1c?style=flat-square">
  <img alt="Internal" src="https://img.shields.io/badge/Internal-shared%20helpers-525252?style=flat-square">
</p>

`@vite-hub/internal` contains shared implementation helpers for package builds, Definition discovery, Provider Output, feature bridges, runtime host plumbing, CLI contribution collection, and tests. It is private and is not an application API.

## Install

Do not install this package directly. It is a workspace-only private package used by other ViteHub packages.

## Minimal API

Application code should not import from `@vite-hub/internal`.

Package code can use explicit internal subpaths when it needs shared implementation contracts:

```ts
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger } from "@vite-hub/internal/build/vite"
```

## Entry points

- `@vite-hub/internal/definition-catalog`: Definition discovery and Runtime Registry helpers.
- `@vite-hub/internal/build/*`: shared build and Provider Output utilities.
- `@vite-hub/internal/feature-bridge/*`: shared Vite/Nitro feature bridge internals.
- `@vite-hub/internal/runtime/*`: runtime host context helpers.

Learn more at [vitehub.dev](https://vitehub.dev).
