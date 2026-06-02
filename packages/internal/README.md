# @vite-hub/internal

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="Private" src="https://img.shields.io/badge/Private-not%20published-b91c1c?style=flat-square">
  <img alt="Internal" src="https://img.shields.io/badge/Internal-shared%20helpers-525252?style=flat-square">
</p>

`@vite-hub/internal` is a private workspace package for shared implementation code. Application code should not import it.

## Install

Do not install this package directly. Other ViteHub packages depend on it inside the monorepo.

## Minimal API

```ts
// packages/*/src/internal-use.ts
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger } from "@vite-hub/internal/build/vite"
```

## Used by

Packages use it for definition discovery, generated runtime registries, Provider Output, hosted runtime helpers, and Vite-to-host feature bridges.

Learn more at [vitehub.dev](https://vitehub.dev).
