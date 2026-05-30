# @vite-hub/devtools

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="DevTools" src="https://img.shields.io/badge/Vite%20DevTools-shell-646cff?style=flat-square">
</p>

`@vite-hub/devtools` registers the ViteHub panel inside Vite DevTools and lets feature packages add their own bridges.

## Install

```sh
pnpm add @vite-hub/devtools
```

## Minimal API

```ts
// vite.config.ts
import { hubDevtools } from "@vite-hub/devtools"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubDevtools()],
})
```

```ts
// packages/feature/src/devtools.ts
import { registerViteHubDevtoolsFeature } from "@vite-hub/devtools"

registerViteHubDevtoolsFeature(ctx, {
  id: "agent.chat",
  packageName: "@vite-hub/agent",
  title: "Chat",
  bridge: "/__vitehub/agent/chat/devtools",
})
```

## Vite

The package is built on [Vite DevTools Kit](https://devtools.vite.dev/) and is used by packages such as [`@vite-hub/agent`](../agent/README.md) to expose package-owned panels.

Learn more at [vitehub.dev](https://vitehub.dev).
