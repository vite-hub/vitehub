# @vite-hub/blob

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=config">
  <img alt="Storage" src="https://comark-ui.onmax.me/badge.svg?label=Blob&amp;value=stores">
</p>

`@vite-hub/blob` gives server code one object-storage API across local files and hosted blob providers.

## Install

```sh
pnpm add @vite-hub/blob h3 valibot
pnpm add -D vite
```

Add the SDK required by the driver you configure.

## Minimal API

```ts
// server/api/files.post.ts
import { blob } from "@vite-hub/blob"
import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, body => v.parse(v.object({ path: v.string(), text: v.string() }), body))

  const [writeError] = await blob.put(body.path, body.text, { contentType: "text/plain" })
  if (writeError) throw writeError

  const [readError, file] = await blob.get(body.path)
  if (readError) throw readError
  return file
})
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBlob({
    driver: "fs",
    base: ".vitehub/data/blob",
  }), nitro()],
})
```

`blob.copy(from, to, { overwrite? })` copies a file in the same store with its content type and custom metadata, and returns the new `BlobObject`. A missing source returns `BLOB_NOT_FOUND`, and a file at `to` returns `BLOB_CONFLICT` unless `overwrite` is `true`. S3-compatible stores and Vercel Blob copy on the server, `fs` copies the file, R2 streams the object from the binding, and Netlify Blobs reads and writes it.

## Vite Integration

Use `hubBlob()` in Vite to resolve blob config and expose the `blob` runtime helper to server code. Nitro is the only host output. `hubBlob()` adds its runtime plugin to the Nitro config, and Nitro bundles it into the server output for each host. On a Cloudflare host, it also adds the R2 bucket bindings to Nitro's `wrangler.json`.

`hubBlob()` writes the keys of `blob.stores` to `.vitehub/types/blob.d.ts`. Include that file in your TypeScript project. `vite-hub` includes it through `.vitehub/types.d.ts`. With that file, a store name that is not configured is a type error in `blob.store()`, `file()`, and `image()`. Without it, any name type checks. At runtime, an unknown name throws `BLOB_R0027`, or `BLOB_R0028` in a generated host runtime, and the message lists the configured names.

For an R2 bucket in a [jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions), set `jurisdiction: "eu"`, `"fedramp"`, or `"us"` on the `cloudflare-r2` store, or set `R2_JURISDICTION` at build time. ViteHub adds it to the `r2_buckets` binding, sends the `cf-r2-jurisdiction` header when provisioning lists and creates buckets, and uses the `<account-id>.<jurisdiction>.r2.cloudflarestorage.com` host for HTTP fallback and signed URLs. A `wrangler` `r2_buckets` entry with the same `binding` and another jurisdiction fails the build.

Core drivers include local `fs`, [Vercel Blob](https://vercel.com/docs/vercel-blob), [Cloudflare R2](https://developers.cloudflare.com/r2/), S3-compatible stores, and [files-sdk](https://files-sdk.dev/).
At config time, the `fs` driver uses `BLOB_FS_BASE` when `blob.base` is omitted, then defaults to `.vitehub/data/blob`.

Filesystem writes stage bytes under `<base>/.vitehub/blob-writes` and rename complete files into place. Each new payload inode has an immutable metadata sidecar prepared before the payload rename. Readers select that inode’s metadata and retry if the payload changes during the read, so replacements expose matching bytes, MIME types, size, and custom metadata. Each sidecar also records the SHA-256 hash and size of its bytes. When you copy, restore, or move the data folder, the payloads get new inodes; a reader then accepts an older sidecar of the same pathname only if its recorded hash matches the current bytes, and saves it under the new inode. A sidecar that records a hash applies only while the bytes still match it, so a file you edit in place loses its metadata. Sidecars written before this hash was recorded do not survive a copy. Legacy files and sidecars remain readable. Deletion removes metadata for the payload generation observed before deletion, preserving concurrent replacements that are still being prepared. Older generation sidecars and interrupted publications can leave small sidecars; deletion does not sweep these because a sweep could remove a concurrent writer’s metadata. These are internal metadata, not additional payload copies. Workspace history stores keep file MIME types in their immutable manifests.

A stopped process can leave staging files. After stopping every writer to the filesystem store, inspect this directory and remove it to reclaim unfinished writes. For the default base:

```sh
du -sh .vitehub/data/blob/.vitehub/blob-writes
rm -rf .vitehub/data/blob/.vitehub/blob-writes
```

This maintenance removes staging files. Published objects and their metadata remain in place. Do not run it while writers are active.

On Vercel, the `vercel-blob` driver uses OIDC when the project has `BLOB_STORE_ID`, which Vercel adds when you connect a store. Off Vercel, it uses `BLOB_READ_WRITE_TOKEN`. Configured Vercel Blob tokens that match `BLOB_READ_WRITE_TOKEN` are masked at build time and read from that variable again at runtime. Configured tokens always take precedence over OIDC.
`vitehub inspect resources` reports other configured tokens with source `config`, without printing a token value or an environment store id.

## Remote stores in development

`vite dev` keeps Blob local unless a store sets `remote: true`. A store without a `driver` that ViteHub infers as S3 from the `S3_*` variables, or as Vercel Blob from `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN`, or the Vercel host, uses the local `fs` driver in `.vitehub/data/blob`. On the Cloudflare host, a store without a `driver` uses the R2 binding of the dev runner when it has one, which is a local emulation, and the local `fs` driver without one.

```ts
import { hubBlob } from "@vite-hub/blob/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBlob({ remote: true }), nitro()],
})
```

With `remote: true`, `vite dev` uses the real store and prints `Blob store "<name>" is remote` on first use. Writes then change real data. `vitehub inspect definitions --kind blob` shows `Development: Remote`. On a `cloudflare-r2` store, `remote: true` uses the R2 API and its HTTP credentials, not the local binding. Builds ignore `remote`. An explicit `driver` is used in `vite dev` as configured, with or without `remote`. A `remote` value that is not a boolean fails with `BLOB_C0017`, and `remote: true` on a local `fs` store fails with `BLOB_C0018`.

Set `blob.serve` to generate a Nitro route for serving Blob-backed assets. Each route says who may read the files: `serve: { access: "public" }` sends every object of the served store to anyone, and `serve: { authorize: true }` requires a signed-in session. A route without one of them, or with both, fails with `BLOB_C0021`. `authorize: false` does not make a route public and fails with `BLOB_C0021` too. The route uses `/api/_vitehub/blob` as a safe namespaced API route by default. Use `serve.route` for product-facing paths such as `/assets`.
`put()` has no `access` option. One object cannot be private in a public store, so `put()` with `access` throws `BLOB_R0045`. Keep private files in a store that the route does not serve, or serve that store with `authorize: true`. On Vercel Blob, `access` on the store sets the provider access. It defaults to `"private"`, or to `"public"` when `serve: { access: "public" }` serves the store, and `access: "public"` on a store that `authorize: true` serves fails with `BLOB_C0022`.
Objects from the served store receive an absolute URL when `serve.publicBaseUrl` is configured, or a route-relative URL otherwise.
`servedBlobUrl(pathname, store?)` from `@vite-hub/blob/served` returns the same URL for a pathname from the generated Blob config, without loading the Blob runtime, so code such as `contentHead()` can link a stored image. It returns `undefined` when the store is not served, and in the browser, where the config is not loaded.
Use `serve.headers` for static cache and security headers. Blob metadata remains authoritative for content headers such as `Content-Type`, `Content-Length`, and `ETag`.
A stored file has the content type that the uploader sent. `serve()` and the serve route send `X-Content-Type-Options: nosniff`, and send `Content-Security-Policy: sandbox` for types that a browser opens as a page: `text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`, `application/xml`, `text/xsl`, `text/rdf`, other `+xml` types, and `multipart/*` types, also when a content type names one of them in a list. A `Content-Security-Policy` from `headers` gets `sandbox` as a second policy. Pass `download: true`, or a file name, to `blob.serve()` to send `Content-Disposition: attachment`. In `ensureBlob()`, a broad type such as `image` or `text` does not accept these types. List them exactly, for example `types: ["image", "image/svg+xml"]`.
When your own middleware checks access before the serve route, use `private, no-cache`, not `no-store`: the browser keeps its copy and revalidates on each use, so the check still runs and an unchanged object answers `304` with no body. `no-store` downloads the full object on every visit.

Application routes can call `blob.serve(request, pathname, { cacheControl, transform: { key, run } })` after their own authorization or database lookup. Pass the `Request` of a Fetchable route, or `event.req` in an H3 or Nitro handler. `serve()` returns a `Response` with the final status and headers, so the route returns it as it is: `200`, `206` or `416` for a range, `304`, `400` with `{ error }` for an unsafe pathname such as `dir/..%2Fpackage.json`, and `404` for a missing object or a reserved path (`_vitehub`, `_vitehub/derived/`, `_vitehub/media/`, and `.vitehub/` on every driver). A storage failure throws its `ViteHubError`. The generated serving route is a Fetchable, `{ fetch(request) }`, that returns that `Response`. When Nitro mounts it, it uses the raw catch-all pathname from the Request context, also behind a `baseURL`. Direct calls read the URL after `serve.route` at the URL root. `run` receives the original `Blob` and returns a response `Blob`. ViteHub stores the derived result in a reserved namespace in the same store, using the store's configured access, leaves the original unchanged, and invalidates the cache when the source or transform key changes. Source changes replace each cached variant on its next request; `blob.delete(originalPath)` clears all its variants. Version the key when the transformation changes and include output variants such as size or format. The method handles conditional GET and HEAD requests. Without a `transform`, it also answers one `Range: bytes=` request with `206` and `Content-Range`, or `416` when the range starts past the end, so media can seek. See [the server API](https://vitehub.dev/docs/blob/server-api#serve-a-transformed-object) for cache lifetimes, an example, and failure behavior.
Set `serve.authorize: true` to require a signed-in `@vite-hub/auth` session through the Auth Vite plugin; the build fails without an Auth Definition. Export `authorize` (type `BlobServeAuthorize`) from `server/blob.ts` to decide each request with the Auth access signature. ViteHub runs the check before the store read and before conditional `304` handling. It returns `401` without a session, `403` for `false`, and a returned `Response` as-is. Authorized responses default to `Cache-Control: private, no-cache`. A `Cache-Control` that middleware set before the route does not replace it.
For files shared by public link, add `serve.anonymous: true`. Then signed-out requests also run the `authorize` export (type `BlobServeAnonymousAuthorize`), with `session` and `user` set to `null`, and `false` returns `401` for them. This needs an explicit option because a callback written for `authorize: true` can expect a user.

Use `detectContentType()` when an application needs to classify leading bytes before storage. It returns a detected MIME type for common images and PDFs, or `undefined` when the signature is unknown. Storage `contentType` remains caller-provided metadata, and recognizing a signature does not prove that a complete file is valid or safe.

```ts
import { detectContentType } from "@vite-hub/blob"

export async function assertContentType(file: File) {
  const detected = detectContentType(new Uint8Array(await file.arrayBuffer()))
  if (detected !== file.type) throw new Error("File content does not match its declared type")
}
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBlob({
    driver: "fs",
    serve: {
      access: "public",
      route: "/assets",
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  })],
})
```

Blob stores binary objects and small object metadata. Keep catalogs, indexes, permissions, search records, domain records, and richer metadata queries in KV, Database, or another NoSQL/catalog store next to Blob.

Pass the cursor returned by `blob.list()` unchanged to the next list call on the same Blob Store. Keep `prefix` and `folded` unchanged. Netlify Blobs listings fail if they cannot decode the cursor.

With `folded: true`, files-sdk drivers (S3 and S3-compatible stores, R2, GCS, and Azure) ask the provider for the folders, so each page is one provider request. A page then holds at most `limit` blobs and folders together.

With a partial prefix such as `docs/re`, a native page can be empty while `hasMore` is true. Continue with the returned cursor to reach the matching entries.

Filesystem listings sort keys by UTF-16 code unit, so `B.txt` comes before `a.txt`. The cursor holds the last listed key, so a key added or removed between pages does not repeat or skip another key. A listing reads only the directories on the `prefix` path and the directories that the page reaches.

Filesystem listings skip child directories removed or replaced by files during traversal, so unaffected blobs remain visible. Permission and path-safety errors still propagate. A store root that is a regular file still fails.

## Read-only handles

`blob.store(name, { mode: "read" })` returns a `ReadonlyBlobStorage` handle with `get()`, `head()`, `list()`, `serve()`, `sign()` for `GET` requests, and `media.get()`, `media.list()`, and `media.variants()`. Write methods are a type error and absent at runtime. `mode` defaults to `"write"`. Another value throws `BLOB_R0038`, and a `PUT` sign request throws `BLOB_R0037`.

```ts
import { blob } from "@vite-hub/blob"

const reports = blob.store("reports", { mode: "read" })
const [error, file] = await reports.get("2026/q1.pdf")
```

The mode limits this API, not the host. The R2 binding or provider token keeps full access, and code can still import the full `blob` export, so it is not a security boundary against code that reads the binding directly. `media.get()` and `serve()` with a transform or variant can store derived records and variants under the reserved `_vitehub/` prefix. They never change your objects.

## Uploads

`blob.handleUpload(event, options)` stores the files of a `multipart/form-data` request and returns `[error, objects]`. `event` is a Nitro, H3, or `nuxt/server` event, or a web `Request`. Options: `formKey` (default `"files"`), `multiple` (default `true`), `ensure` (checked with `ensureBlob()`), and `put` (write options). Request errors throw H3 400 errors before anything is stored. When the build targets Vercel, `vite dev` also throws an H3 413 error for a request body above 4.5 MB, as a [Vercel Function](https://vercel.com/docs/functions/limitations#request-body-size) does. With `multiple: false` and `ensure.maxSize`, a `Content-Length` above `maxSize` plus 64 KB of form framing gets an H3 413 error before the body is read.

`onBeforeUpload({ pathname, contentType, size, request })` runs for each file before anything is stored: throw to reject it, or return `{ pathname }` to change it. `onCompleted(object, request)` runs after each file is stored. With `direct: true`, the route also answers direct uploads: the client sends JSON `{ action: "sign", name, contentType, size }`, gets a signed `PUT` and a `ticket`, sends the file straight to storage, and then sends `{ action: "complete", ticket }`. `complete` reads the object with `head()`, deletes it and throws 400 when its size or type fails `ensure`, and runs `onCompleted`. The client reports the completion, so a closed tab skips `onCompleted`. The ticket is signed with `VITEHUB_SECRET` and binds the pathname and the route path. A store that cannot sign a `PUT`, such as Netlify Blobs, answers `{ action: "form" }`, and the client sends a form. R2, S3, GCS, and Azure buckets need a CORS rule that allows `PUT` from the app origin. `useUpload(url, { direct: true })` and `uploadFiles(url, files, { direct: true })` run the three steps.

`blob.handleMultipartUpload(event, options)` serves `create`, `upload`, `complete`, and `abort` requests from a route with `action` and `pathname` params, such as `server/api/files/multipart/[action]/[...pathname].ts`. `blob.createMultipartUpload()` and `blob.resumeMultipartUpload()` drive an upload from server code. The `fs`, `cloudflare-r2` (binding), and `vercel-blob` drivers support multipart uploads. Other drivers throw `BLOB_R0030`. Pass `ensure` (`types`, `maxSize`) to limit an upload: `create` checks the content type and the size the client declares, `upload` rejects a larger part, and `complete` deletes an object whose size or stored content type fails the policy.

Upload routes accept client-chosen pathnames. Authorize each request in the route. Blob methods decode a pathname once and reject empty pathnames, control characters, `%` followed by two hex digits, and `.` or `..` segments with `BLOB_R0034` (`statusCode: 400`). So each pathname that `put()` or `list()` returns targets the same object when you pass it back. `put()` checks the final pathname after `prefix` and `addRandomSuffix`. A `cloudflare-r2` store returns `BLOB_PATHNAME_TOO_LONG` for a pathname above the [R2 key limit](https://developers.cloudflare.com/r2/platform/limits/) of 1024 bytes. `handleUpload()` stores file names without URL-decoding, and replaces the `%` of each `%XX` sequence with `_`, adding a UUID suffix before the extension to avoid overwriting a different file.

Browser clients:

- `@vite-hub/blob/client`: `uploadFiles()` and `createMultipartUploader()`, built on `fetch`. `uploadFiles(route, files, { onProgress })` reports progress from 0 to 100 and sends with XMLHttpRequest, since `fetch` can't report upload progress.
- `@vite-hub/blob/vue`: `useUpload()` and `useMultipartUpload()`, which add a progress ref. `vue` is an optional peer dependency.

## Blob reference schemas

`image()` and `file()` return [Standard Schema](https://standardschema.dev) validators for a stored pointer to one object: `{ pathname, contentType?, size? }`. They accept a `BlobObject` from `put()` or `handleUpload()` and drop its other fields. They reject unsafe pathnames, such as absolute paths and `..` segments, and they check `accept` against `contentType` and `maxSize` against the recorded `size`. They don't read the store.

```ts fragment
import { file, image } from "@vite-hub/blob"

const cover = image({ store: "media", maxSize: "8MB" }) // accepts image/* by default
const attachment = file({ accept: ["application/pdf"] })

const result = cover["~standard"].validate(uploadedObject)
const jsonSchema = cover["~standard"].jsonSchema.input({ target: "draft-2020-12" })
// jsonSchema["x-vitehub-blob"] -> { kind: "image", store: "media", accept: ["image/*"], maxSize: "8MB" }
```

The JSON Schema `x-vitehub-blob` keyword tells a form to render a Blob picker. Zod 4 and Valibot object schemas accept only their own schema types, so these validators can't be fields inside `z.object()` or `v.object()`. Use them where a Standard Schema is read directly.

## Media and image variants

`blob.media` keeps a JSON record next to each object under `_vitehub/media/records/`: dimensions read from the file header, a SHA-256 hash, alt text, a caption, a focal point, a placeholder color, and named crops. Records work on every driver, including drivers without custom metadata.

Pass the uploaded `file` from your app to this helper.

```ts
import { blob, responsiveImage } from "@vite-hub/blob"

export async function storeCover(file: Blob) {
  const [error] = await blob.media.put("posts/cover.jpg", file, { alt: "Cover", focal: { x: 0.7, y: 0.4 } })
  if (error) throw error
  const [updateError] = await blob.media.update("posts/cover.jpg", { crops: { mobile: { aspect: "4:5" } } })
  if (updateError) throw updateError
  const [moveError, record] = await blob.media.move("posts/cover.jpg", "posts/2026/cover.jpg")
  if (moveError) throw moveError

  return responsiveImage(record, { sizes: "100vw", art: [{ media: "(max-width: 640px)", crop: "mobile" }] })
  // img: { src, srcset, sizes, width, height, alt, style }, sources: <picture> sources
}
```

The generated serve route returns variants for `?w=&h=&fit=&fmt=&q=&crop=`. Sizes snap to an allowed list and never upscale. `blob.images.transformer` picks sharp on Node (optional peer), the Cloudflare Images binding on Workers, or passthrough, which serves originals. `transformer: "photon"` uses `@cf-wasm/photon` (optional peer), a WebAssembly image library that runs on Workers and Node without a binding. `@vite-hub/blob/media` exports the browser-safe helpers.

`responsiveImage()` uses the same default size list for its `srcset` widths. If you set `blob.images.sizes`, pass that list as `responsiveImage(record, { imageSizes })` so the width descriptors match the served variants.

`@vite-hub/blob/nuxt-image` is a `@nuxt/image` provider for the serve route. It maps `width`, `height`, `fit`, `format`, `quality`, and a `crop` modifier to the variant parameters, and snaps sizes like the server. `vite-hub/nuxt` registers it as `vitehub` when the app uses `@nuxt/image` and sets `blob.serve`.

## Signed requests

Use `blob.sign()` to grant short-lived access to one private object without routing its body through your server.

```ts
import { blob } from "@vite-hub/blob"

export async function shareAudio(file: Blob) {
  const [downloadError, download] = await blob.sign("private/audio.mp3", {
    method: "GET",
    expiresIn: 60 * 60,
  })
  if (downloadError) throw downloadError

  const [uploadError, upload] = await blob.sign("private/audio.mp3", {
    method: "PUT",
    expiresIn: 15 * 60,
    contentType: "audio/mpeg",
    createOnly: true,
  })
  if (uploadError) throw uploadError

  await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
  })
  return download.url
}
```

Blob operations return a `Result` from `@vite-hub/runtime`: `[error, undefined]` or `[undefined, value]`. Missing objects return `[undefined, null]` from `get()` and `head()`, including when a serving route is configured. Provider and storage failures return an error with a stable `BLOB_*` code, `why`, `fix`, `docs`, and the provider failure in `cause`. Invalid arguments, unknown stores, and unsupported signing capabilities throw Nostics diagnostics with package-owned `BLOB_C####`, `BLOB_B####`, or `BLOB_R####` codes. Catch these defects by code. See [Errors and diagnostics](https://vitehub.dev/docs/reference/errors-diagnostics).

The returned headers are part of the request contract and must be sent unchanged. `createOnly` prevents overwriting an existing object when the driver can enforce a conditional upload.

`maxSize`, such as `"8MB"`, limits the body of a `PUT`. Only the `fs` and `vercel-blob` drivers bind it.

The `fs` driver, the `cloudflare-r2` driver, the files-sdk drivers, and the `vercel-blob` driver sign requests. The `vercel-blob` driver signs a `PUT` only, as a request to the Vercel Blob API with a client token from `BLOB_READ_WRITE_TOKEN`. The token binds the pathname, `contentType`, `maxSize`, `createOnly`, and the expiry. An `fs` store signs a link to the `/_vitehub/blob/signed/<store>/<pathname>` route of the app, which ViteHub adds only when a store uses the `fs` driver. The route checks the link, then serves the file with `serve()` or stores the body with `put()`. It answers `403` for an expired or changed link (`BLOB_R0042`, `BLOB_R0041`), `405` for another method, and `413` for a body larger than `maxSize` (`BLOB_R0043`). The HMAC-SHA256 key comes from `VITEHUB_SECRET` or `NUXT_APP_SECRET` with the purpose `vitehub:blob:sign`, so a link works on another instance only with the same secret and the same folder, such as a shared volume. Set `urlBaseUrl` on the store for absolute links, with the base URL of the app when it has one, such as `https://app.example/app`. The `fs` driver cannot bind `createOnly`. A files-sdk driver signs a `GET` only when its provider issues a URL with an exact expiry, and a `PUT` only when its provider issues a direct upload URL. Files-sdk drivers cannot bind `createOnly`. When the provider cannot sign the request, `sign()` returns a `BLOB_OPERATION_FAILED` error with the reason in `cause`.

## S3-compatible storage

Use `driver: "s3"` for production S3-compatible object storage. Use `driver: "minio"` for local or Docker Compose object storage, and use `driver: "cloudflare-r2"` for Cloudflare R2.

```sh
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

Cloudflare R2 HTTP fallback also requires:

```sh
pnpm add @aws-sdk/lib-storage
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBlob({
    driver: "s3",
    bucket: "app-assets",
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    publicBaseUrl: "https://assets.example.com",
  })],
})
```

Store S3 credentials in Server Env or the provider credential chain used by the S3 SDK. Keys go in `credentials`; a top-level `accessKeyId` or `secretAccessKey`, as in NuxtHub, fails with `BLOB_C0021`.

Without a `driver`, a build with `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_BUCKET` (NuxtHub's names) uses this store before any host default. `S3_REGION` and `S3_ENDPOINT` apply when they are set. The server reads the keys from the same variables. `vite dev` keeps the local `fs` store unless the store sets `remote: true`.

Blob never writes a credential into the server bundle. Leave `credentials` out so the SDK reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` at runtime, or set each credential option from `process.env`. ViteHub then writes only the name of the env variable that holds the value at build time, and reads that variable when the store starts. This applies to the credential options of every driver, such as `secretAccessKey`, `token`, `accountKey`, and `credentials.private_key`. A URL option with a user name, password, or query, and an option that the driver does not know, are also credentials. A literal credential fails `vite dev` and the build with `BLOB_C0019`. A value that more than one env variable holds fails with `BLOB_C0020`. A variable that the server does not have fails with `BLOB_R0044` when the store starts.

## MinIO

MinIO is the Docker-friendly S3-compatible path. Select it explicitly:

```sh
pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
```

```ts
// vite.config.ts
import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubBlob({
    driver: "minio",
  })],
})
```

ViteHub reads common Docker Compose env names:

```env
MINIO_ENDPOINT=http://minio:9000
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=password
BLOB_BUCKET_NAME=vitehub-blob
```

The Files SDK native `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY` env names are also accepted.

You can also keep the config self-contained:

```ts fragment
blob: {
  driver: "minio",
  accessKeyId: process.env.MINIO_ROOT_USER,
  bucket: "vitehub-blob",
  endpoint: "http://minio:9000",
  forcePathStyle: true,
  secretAccessKey: process.env.MINIO_ROOT_PASSWORD,
}
```

## CLI

`hubBlob()` contributes the `vitehub blob` CLI namespace: `list [--prefix] [--limit] [--cursor]`, `head <pathname>`, `get <pathname> [--output <file>]`, `put <pathname> <file> [--content-type]`, `delete <pathname>`, `media <pathname>`, and `variants <pathname>`. Each command accepts `--store <name>` and `--json`. Write commands print what they changed. The `created` and `deleted` labels are best-effort metadata observations before each mutation. They can be stale with eventual consistency or concurrent writers. Deletion is unconditional and can remove an object replaced concurrently. There is no `sign` command.

Each command runs a `blob.*` operation of the app through the Console RPC, on the dev server or, with `--url`, on a deployed app. `get` and `put` carry the file as base64 JSON, so they accept files up to 8 MiB. The Console Blob page uploads and deletes objects with the same operations.

Learn more at [vitehub.dev](https://vitehub.dev).
