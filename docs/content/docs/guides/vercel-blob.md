---
title: Store private files in Vercel Blob with ViteHub
description: Configure a private Vercel Blob store, keep the token on the server, and serve stored files through an application route.
navigation.title: Vercel Blob
navigation.order: 15
navigation.group: Storage
icon: i-simple-icons-vercel
---

Use Vercel Blob when your Vercel app needs persistent object storage. The
function filesystem is not a shared, durable store.

Complete [Upload your first Blob object](/docs/blob/get-started). Keep its
upload and read routes. Create a private Vercel Blob store and connect it to
your project. Obtain its `BLOB_READ_WRITE_TOKEN`.

## Select private storage

Keep your other Vite plugins and add these ViteHub options:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		preset: 'vercel',
		blob: { driver: 'vercel-blob', access: 'private' },
	})],
})
```

Set `BLOB_READ_WRITE_TOKEN` in the project's preview and production server
environments as needed. Set it in your local shell to test against that store.
Do not copy the token into browser code or a literal config value.

## Check uploads and reads

Build the app. ViteHub writes `.vercel/output` for the selected preset.
Deploy it through the linked Vercel project, as described in
[Deploy an Agent](/docs/guides/deploy-agent-cloudflare-vercel).

Set `APP_URL` to the deployment URL and call the Blob tutorial's routes:

```bash [Terminal]
curl --fail-with-body "$APP_URL/api/files" \
  -H 'content-type: text/plain' --data-binary 'Hello from ViteHub'
curl --fail-with-body "$APP_URL/api/files"
```

Confirm the file in the Vercel store. The GET route returns its stored text
through the server. This check does not require a public object URL.

## Protect the application route

Private storage controls direct provider access. It does not authenticate
visitors to your own GET route. The tutorial route is public.

Require an Auth session or an application access check before returning private
user files. The generated Blob serve route supports
[`serve.authorize`](/docs/blob/configure#protect-served-objects). A public
application route can expose private stored bytes if it performs no check.

An access-mode error can mean the store and `access` setting do not match.
A missing-token error requires the token in the function's environment.
Read [Vercel Blob documentation](https://vercel.com/docs/vercel-blob) for access
modes and service limits, and [Blob configuration](/docs/blob/configure) for
overwrite behavior and named stores.
