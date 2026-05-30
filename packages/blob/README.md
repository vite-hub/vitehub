# @vite-hub/blob

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-config-646cff?style=flat-square">
  <img alt="Storage" src="https://img.shields.io/badge/Blob-stores-0f766e?style=flat-square">
</p>

`@vite-hub/blob` gives server code one object-storage API across local files and hosted blob providers.

## Install

```sh
pnpm add @vite-hub/blob
```

Add the SDK required by the driver you configure.

## Minimal API

```ts
// server/api/files.post.ts
import { blob } from "@vite-hub/blob"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ path: string, text: string }>(event)

  await blob.put(body.path, body.text, { contentType: "text/plain" })

  return blob.get(body.path)
})
```

```ts
// nitro.config.ts
import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vite-hub/blob/nitro"],
  blob: {
    driver: "fs",
    base: ".data/blob",
  },
})
```

## Vite and Nitro

Use `hubBlob()` in Vite or `@vite-hub/blob/nitro` in Nitro. Both resolve the same `blob` config and expose the same `blob` runtime helper.

Core drivers include local `fs`, [Vercel Blob](https://vercel.com/docs/vercel-blob), [Cloudflare R2](https://developers.cloudflare.com/r2/), S3-compatible stores, and [files-sdk](https://files-sdk.dev/).

Learn more at [vitehub.dev](https://vitehub.dev).
