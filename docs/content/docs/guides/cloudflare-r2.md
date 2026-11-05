---
title: Store files in Cloudflare R2 with ViteHub
description: Connect ViteHub Blob to an R2 bucket, generate a Worker binding, and verify file upload and retrieval.
navigation.title: Cloudflare R2
navigation.order: 14
navigation.group: Storage
icon: i-simple-icons-cloudflare
---

Use Cloudflare R2 for object storage on a Worker. ViteHub Blob keeps the upload
and read API separate from the R2 binding.

Complete [Upload your first Blob object](/docs/blob/get-started). Keep its
`hello.txt` routes. Create an R2 bucket for this check. Provider requests and
stored bytes can incur charges.

## Name the bucket in configuration

Replace the tutorial's ViteHub options with the following. Use your existing
bucket name.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		preset: 'cloudflare',
		blob: {
			driver: 'cloudflare-r2',
			binding: 'BLOB',
			bucketName: 'your-existing-bucket',
		},
	})],
})
```

Build and inspect `.output/server/wrangler.json`. Its `r2_buckets` entry must
name the intended bucket and the `BLOB` binding.

```bash [Terminal]
pnpm build
pnpm exec nitro deploy --prebuilt
```

Authenticate with Cloudflare before deploying. If the bucket is in a
jurisdiction, configure the matching `jurisdiction` option. Read
[Blob hosts](/docs/blob/hosts) for jurisdictional buckets.

## Verify stored bytes

Set `APP_URL` to the Worker URL, then call the tutorial's routes:

```bash [Terminal]
curl --fail-with-body "$APP_URL/api/files" \
  -H 'content-type: text/plain' --data-binary 'Hello from ViteHub'
curl --fail-with-body "$APP_URL/api/files"
```

The read returns `Hello from ViteHub`. Check the bucket for `hello.txt`.
The write replaces that fixed pathname. Delete the test object when finished.

## Distinguish storage from public access

An R2 binding does not make the bucket public. `blob.serve()` can return bytes
through your application route. Use [Blob authorization](/docs/blob/configure)
before serving private user files.

Signed direct uploads need R2 account and S3 credentials even when a Worker
binding exists. A binding alone cannot sign an HTTP request. Keep these
credentials in server secret storage.

Read [Blob configuration](/docs/blob/configure) for the HTTP fallback and
[R2 documentation](https://developers.cloudflare.com/r2/) for bucket access,
pricing, and service limits.
