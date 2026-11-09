---
title: Store files in Cloudflare R2 with ViteHub
description: Connect ViteHub Blob to an R2 bucket, generate a Worker binding, and verify file upload and retrieval.
navigation.title: Cloudflare R2
navigation.order: 14
navigation.group: Storage
icon: i-simple-icons-cloudflare
---

Use Cloudflare R2 to store files on a Worker. Your code uses the Blob API, and
the config picks R2.

First, complete [Upload your first Blob object](/docs/blob/get-started) and
keep its `hello.txt` routes. Create an R2 bucket. Requests and stored bytes
cost money.

## Name the bucket in configuration

Replace the tutorial's options with these and use your bucket name.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
  	host: 'cloudflare',
  	blob: {
  		driver: 'cloudflare-r2',
  		binding: 'BLOB',
  		bucketName: 'your-existing-bucket',
  	},
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		host: 'cloudflare',
		blob: {
			driver: 'cloudflare-r2',
			binding: 'BLOB',
			bucketName: 'your-existing-bucket',
		},
	}), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		host: 'cloudflare',
		blob: {
			driver: 'cloudflare-r2',
			binding: 'BLOB',
			bucketName: 'your-existing-bucket',
		},
	})],
})
```
:::
::

Build, then check that the `r2_buckets` entry in `.output/server/wrangler.json`
names your bucket and the `BLOB` binding.

```bash [Terminal]
pnpm build
pnpm exec nitro deploy --prebuilt
```

Log in to Cloudflare before you deploy. If the bucket is in a jurisdiction,
set the matching `jurisdiction` option (see [Blob hosts](/docs/blob/hosts)).

## Verify stored bytes

Set `APP_URL` to the Worker URL and call the tutorial's routes:

```bash [Terminal]
curl --fail-with-body "$APP_URL/api/files" \
  -H 'content-type: text/plain' --data-binary 'Hello from ViteHub'
curl --fail-with-body "$APP_URL/api/files"
```

The read returns `Hello from ViteHub`, and the bucket has `hello.txt` (each
write replaces it). Delete it when you finish.

## Distinguish storage from public access

An R2 binding does not make the bucket public. `blob.serve()` returns bytes
through your route. Add [Blob authorization](/docs/blob/configure) before you
serve private files.

Signed direct uploads need R2 account and S3 credentials, because a binding
cannot sign an HTTP request. Keep them in server secrets.

See [Blob configuration](/docs/blob/configure) for the HTTP fallback and the
[R2 docs](https://developers.cloudflare.com/r2/) for bucket access, pricing,
and limits.
