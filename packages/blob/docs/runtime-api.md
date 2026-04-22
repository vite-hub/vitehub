---
title: Runtime API
description: Public Blob runtime types and helper exports.
frameworks: [vite, nitro]
---

## Modules

| Export | Purpose |
| --- | --- |
| `@vitehub/blob` | Runtime Blob handle, validation helper, and types. |
| `@vitehub/blob/nitro` | Nitro module for Blob runtime config and provider wiring. |
| `@vitehub/blob/vite` | Vite plugin returned by `hubBlob()`. |
| `virtual:@vitehub/blob/config` | Resolved Vite Blob config for server environments. Vite only. |

## Runtime Handle

```ts
import { blob } from '@vitehub/blob'
```

The `blob` handle exposes:

- `blob.list(options?)`
- `blob.get(pathname)`
- `blob.put(pathname, body, options?)`
- `blob.head(pathname)`
- `blob.del(pathname | pathnames[])`
- `blob.delete(pathname | pathnames[])`
- `blob.serve(event, pathname)`

## Types

```ts
type BlobDriver = 'cloudflare-r2' | 'fs' | 'vercel-blob'
```

`BlobObject` contains `pathname`, `contentType`, `size`, `httpEtag`, `uploadedAt`, `httpMetadata`, `customMetadata`, and optional `url`.

## Nitro Module

```ts
import blobModule from '@vitehub/blob/nitro'
```

Register the module through `modules: ['@vitehub/blob/nitro']` in `nitro.config.ts`.

## Vite Virtual Config

```ts
import config, { blob, hosting } from 'virtual:@vitehub/blob/config'
```

The virtual module exposes the resolved hosting hint and Blob store config used by the plugin.
