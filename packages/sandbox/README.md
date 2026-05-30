# @vite-hub/sandbox

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
  <img alt="Sandbox" src="https://img.shields.io/badge/Sandbox-isolated%20runs-b45309?style=flat-square">
</p>

`@vite-hub/sandbox` runs typed work in an isolated provider runtime without coupling callers to that provider.

## Install

```sh
pnpm add @vite-hub/sandbox
```

Add `@cloudflare/sandbox` or `@vercel/sandbox` for the provider you use.

## Minimal API

```ts
// server/sandboxes/release-notes.ts
import { defineSandbox } from "@vite-hub/sandbox"

export default defineSandbox(async (payload: { notes?: string } = {}) => {
  return {
    summary: payload.notes?.split("\n")[0] ?? "",
  }
})
```

```ts
// server/api/release-notes.post.ts
import { runSandbox } from "@vite-hub/sandbox"

export default defineEventHandler(async (event) => {
  const result = await runSandbox("release-notes", await readBody(event))
  return result.isOk() ? result.value : { error: result.error.message }
})
```

```ts
// nitro.config.ts
import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vite-hub/sandbox/nitro"],
  sandbox: { provider: "cloudflare" },
})
```

## Vite and Nitro

Nitro discovers `server/sandboxes/<name>.ts`. Vite also supports `src/<name>.sandbox.ts` through `hubSandbox()`. Provider config selects [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) or [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox/).

Learn more at [vitehub.dev](https://vitehub.dev).
