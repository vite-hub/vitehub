---
title: Storage Providers
description: Configure @vite-hub/blob with first-class storage drivers.
navigation.title: Storage Providers
navigation.group: Providers
navigation.order: 30
icon: i-lucide-database
frameworks: [vite, nitro]
---

ViteHub exposes provider names directly through `blob.driver`. Users configure ViteHub Blob only; provider implementation details stay inside the package.

Non-first-class providers are powered by `files-sdk`. Install it when using the drivers on this page:

```bash
pnpm add @vite-hub/blob files-sdk
```

ViteHub generates provider-specific runtime imports so only the selected driver is reachable from the deployment bundle. Installing `files-sdk` may still install dependencies for providers you are not using.

## Object Storage

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubBlob()],
  blob: {
    driver: 's3',
    bucket: 'assets',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  },
})
```

Use the same shape for S3-compatible providers:

```ts
blob: {
  driver: 'minio',
  bucket: 'assets',
  endpoint: 'http://localhost:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY_ID,
  secretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY,
}
```

Supported S3-compatible drivers are `s3`, `minio`, `digitalocean-spaces`, `storj`, `hetzner`, and `akamai`.

## Cloud Providers

```ts
blob: {
  driver: 'gcs',
  bucket: 'assets',
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
}
```

```ts
blob: {
  driver: 'azure',
  container: 'assets',
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
}
```

```ts
blob: {
  driver: 'supabase',
  bucket: 'assets',
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
}
```

```ts
blob: {
  driver: 'netlify-blobs',
  name: 'assets',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_AUTH_TOKEN,
}
```

## App Storage

```ts
blob: {
  driver: 'dropbox',
  accessToken: process.env.DROPBOX_ACCESS_TOKEN,
  rootFolderPath: '/uploads',
}
```

```ts
blob: {
  driver: 'uploadthing',
  token: process.env.UPLOADTHING_TOKEN,
}
```

The app storage drivers are `uploadthing`, `google-drive`, `onedrive`, `dropbox`, and `box`.
