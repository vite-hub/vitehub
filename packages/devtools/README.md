# @vite-hub/devtools

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="DevTools" src="https://img.shields.io/badge/Vite%20DevTools-shell-646cff?style=flat-square">
</p>

`@vite-hub/devtools` owns the ViteHub DevTools Integration. It registers the hosted DevTools shell with Vite DevTools and gives feature packages a shared registration contract for package-owned DevTools Features and bridges.

## Install

```sh
pnpm add @vite-hub/devtools
```

## Minimal API

```ts
import { defineConfig } from "vite"
import { hubDevtools } from "@vite-hub/devtools"

export default defineConfig({
  plugins: [hubDevtools()],
})
```

```ts
import { registerViteHubDevtoolsFeature } from "@vite-hub/devtools"

registerViteHubDevtoolsFeature(ctx, {
  id: "agent.chat",
  packageName: "@vite-hub/agent",
  title: "Chat",
  bridge: "/__vitehub/agent/chat/devtools",
})
```

## Entry points

- `@vite-hub/devtools`: `hubDevtools()`, feature registration helpers, panel constants, and feature types.
- `@vite-hub/devtools/chat-shared`: shared Chat DevTools bridge event and RPC types.

Learn more at [vitehub.dev](https://vitehub.dev).
