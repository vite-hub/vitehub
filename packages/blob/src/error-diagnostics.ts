import { defineErrors } from "@vite-hub/runtime"
import { defineDiagnostics } from "nostics"

import type { BlobOperation } from "./types.ts"

interface BlobErrorParams {
  /** A more precise reason, such as the pathname that already exists. */
  detail?: string
  operation: BlobOperation
  store: string
}

// Runtime errors. Blob operations return them as `[error, undefined]`. Each code has a heading on the docs page.
export const blobErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/blob/diagnostics",
  codes: {
    BLOB_CONFLICT: {
      why: ({ detail, operation, store }: BlobErrorParams) => detail ?? `The Blob ${operation} operation conflicts with existing objects in the "${store}" store.`,
      fix: "Use a free pathname or an empty folder. `media.move()` replaces an object with `{ overwrite: true }`, and `media.removeFolder()` removes the objects of a folder with `{ force: true }`.",
    },
    BLOB_NOT_FOUND: {
      why: ({ detail, operation, store }: BlobErrorParams) => detail ?? `The Blob ${operation} operation found no object in the "${store}" store.`,
      fix: "Check the pathname and the store. A route that throws this error answers 404.",
    },
    BLOB_OPERATION_FAILED: {
      why: ({ operation, store }: BlobErrorParams) => `The Blob ${operation} operation failed on the "${store}" store.`,
      fix: "Read `error.cause` for the provider error. Retry when the provider is available again.",
    },
    BLOB_PATHNAME_TOO_LONG: {
      why: ({ detail, store }: BlobErrorParams) => detail ?? `The pathname is longer than the "${store}" store accepts.`,
      fix: "Use a shorter pathname. Cloudflare R2 accepts object keys of at most 1,024 bytes in UTF-8, after `prefix` and `addRandomSuffix`.",
    },
  },
})


const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

/** A code whose call site passes the message as `why`, with the fix that the reader applies. */
const withFix = (fix: string) => ({ ...dynamicError, fix })

// Thrown errors. Each code identifies one ViteHub failure site. Keep published codes stable.
export const blobErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/blob/diagnostics",
  codes: {
    BLOB_R0027: withFix("Use one of the store names that the message lists, or add the store to `blob.stores` in the Vite config, for example `stores: { default: { driver: \"fs\" }, media: { driver: \"fs\" } }`."),
    BLOB_C0001: withFix("Set `blob.driver` to a supported driver, for example `\"fs\"`, `\"cloudflare-r2\"`, `\"vercel-blob\"`, `\"netlify-blobs\"`, `\"minio\"`, or `\"s3\"`. Check the spelling."),
    BLOB_C0002: withFix("Set `blob.serve.headers` to an object of header names and string values, for example `{ \"Cache-Control\": \"public, max-age=300\" }`."),
    BLOB_C0003: withFix("Make each value in `blob.serve.headers` a string, for example `\"public, max-age=300\"`. Write a number as a string."),
    BLOB_C0004: withFix("Use a valid HTTP header in `blob.serve.headers`. A header name has no spaces or colons, and a value has no line breaks."),
    BLOB_C0005: withFix("Set `blob.serve` to `true` or to an object, for example `{ route: \"/assets\" }`."),
    BLOB_C0006: withFix("Set `blob.serve.store` to a key of `blob.stores`, or remove it to serve the `default` store."),
    BLOB_C0007: withFix("Set `blob` in the Vite config to an object, for example `{ driver: \"fs\" }`, or to `false`."),
    BLOB_C0008: withFix("Add a `default` store to `blob.stores`, for example `stores: { default: { driver: \"fs\" } }`."),
    BLOB_C0009: withFix("If you set `token` in the Blob config, set `BLOB_READ_WRITE_TOKEN` in the runtime environment. Otherwise, on Vercel, connect a Blob store to the project, so that it gets `BLOB_STORE_ID`. Off Vercel, set `BLOB_READ_WRITE_TOKEN` in the runtime environment."),
    BLOB_C0010: withFix("Set `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID` in the runtime environment, or set `accessKeyId` on the `minio` store."),
    BLOB_C0011: withFix("Set `MINIO_SECRET_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_ROOT_PASSWORD`, or `AWS_SECRET_ACCESS_KEY` in the runtime environment, or set `secretAccessKey` on the `minio` store."),
    BLOB_C0012: withFix("Set `blob.serve.authorize: true`, and export an `authorize` function from `server/blob.ts`. Do not put the function in the Vite config."),
    BLOB_C0013: withFix("Set `blob.stores` to an object of named stores, for example `{ default: { driver: \"fs\" } }`."),
    BLOB_C0014: withFix("Set `jurisdiction` on the `cloudflare-r2` store, or `R2_JURISDICTION`, to `\"eu\"`, `\"fedramp\"`, or `\"us\"`. Remove it for a bucket without a jurisdiction."),
    BLOB_C0015: withFix("Change `blob.images` as the message says, for example `{ transformer: \"sharp\", quality: 80, sizes: [320, 640, 1280] }`. Set `blob.images: false` to turn image variants off."),
    BLOB_C0016: withFix("Set `blob.serve.anonymous` to `true` or `false`. It needs `blob.serve.authorize: true` and an `authorize` export in `server/blob.ts`."),
    BLOB_C0017: withFix("Set `remote` to `true` or `false`, or remove it."),
    BLOB_C0018: withFix("Set a hosted `driver` on the store, for example `\"cloudflare-r2\"` or `\"vercel-blob\"`, or remove `remote: true`."),
    BLOB_C0019: withFix("Put the credential in an env variable, and set the option to `process.env.<NAME>`, for example `secretAccessKey: process.env.S3_SECRET_ACCESS_KEY`. ViteHub writes only the variable name into the build output and reads the value at runtime, so set the variable for the build and for the server. A value that `loadEnv()` reads from a `.env` file is not in `process.env`: set the variable in the shell or CI, or copy the `loadEnv()` result into `process.env` before the config uses it. Or remove the option when the driver reads its own env variable, such as `AWS_SECRET_ACCESS_KEY` for `s3`."),
    BLOB_C0020: withFix("Give the credential a value that no other env variable has in the build environment, for example remove the other variable from the build environment. Or remove the option when the driver reads its own env variable, such as `AWS_SECRET_ACCESS_KEY` for `s3`, or `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` for `minio`."),
    BLOB_B0001: withFix("Set `blob.serve.authorize: true` so that the serve route calls the `authorize` export of `server/blob.ts`. Or remove the `authorize` export."),
    BLOB_B0002: withFix("Set `auth: true` in `vitehub()` and create `server/auth.ts`. With `@vite-hub/blob` alone, add `hubAuth()` from `@vite-hub/auth/vite` to the Vite plugins. Or remove `blob.serve.authorize`."),
    BLOB_B0003: withFix("Keep one `server/blob` file. Delete or merge the other files that the message lists."),
    BLOB_B0004: withFix("Install the packages that the message names with the command in the message. Or set another `driver` on the store."),
    BLOB_B0005: withFix("Install sharp with `pnpm add sharp`. Or set `blob.images.transformer` to `\"auto\"`, `\"photon\"`, or `\"passthrough\"`."),
    BLOB_B0006: withFix("Export an `authorize` function from `server/blob.ts`, or remove `blob.serve.anonymous`."),
    BLOB_B0007: withFix("Install Photon with `pnpm add @cf-wasm/photon`. Or set `blob.images.transformer` to `\"auto\"`, `\"sharp\"`, or `\"passthrough\"`."),
    BLOB_R0001: withFix("Add an `r2_buckets` entry with this binding to the Wrangler config, or set `binding` on the `cloudflare-r2` store to an existing binding. The default binding is `BLOB`. A build with a Cloudflare preset adds the binding to `wrangler.json`."),
    BLOB_R0002: withFix("Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `BLOB_BUCKET_NAME` in the runtime environment, or set `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` on the `cloudflare-r2` store. Create the access keys as an R2 API token in the Cloudflare dashboard."),
    BLOB_R0003: withFix("Set `BLOB_BUCKET_NAME` in the runtime environment, or set `bucketName` on the `cloudflare-r2` store. Without an R2 binding, the store uses the R2 HTTP API, which needs the bucket name."),
    BLOB_R0004: withFix("Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `BLOB_BUCKET_NAME` in the runtime environment, or set `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` on the `cloudflare-r2` store. Create the access keys as an R2 API token in the Cloudflare dashboard."),
    BLOB_R0005: withFix("Use a pathname inside the store, without `..` segments or a `.vitehub` folder. Remove symbolic links and hard links from the `fs` store folder, which is `.vitehub/data/blob` by default."),
    BLOB_R0006: withFix("Run the app on Netlify or with `netlify dev`, which give the Netlify Blobs context. Off Netlify, set `siteID` and `token` on the `netlify-blobs` store."),
    BLOB_R0007: withFix("Remove `consistency: \"strong\"` from the `netlify-blobs` store. This environment has no uncached Netlify edge URL."),
    BLOB_R0008: withFix("Run the app in a Netlify deploy, which gives the deploy ID and the region, or remove `deployScoped: true` from the `netlify-blobs` store."),
    BLOB_R0009: withFix("Run the app in a Netlify deploy, which gives the deploy ID and the region, or remove `deployScoped: true` from the `netlify-blobs` store."),
    BLOB_R0010: withFix("Check the `siteID` and `token` of the `netlify-blobs` store, then retry. A status of 401 or 403 means that the token cannot read the store. If the response stays invalid, report it at https://github.com/vite-hub/vitehub/issues with the message."),
    BLOB_R0011: withFix("Remove `customMetadata` from the `put()` or `createMultipartUpload()` options. Vercel Blob keeps no custom metadata. Use another driver, for example `cloudflare-r2`, to keep it."),
    BLOB_R0012: withFix("Install the package that the message names with the command in the message. Or set another `driver` on the store."),
    BLOB_R0013: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Vite config."),
    BLOB_R0014: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Vite config."),
    BLOB_R0015: withFix("This is a ViteHub bug. Report it at https://github.com/vite-hub/vitehub/issues with the message and your Vite config."),
    BLOB_R0017: withFix("Retry the list call. If it fails again, report it at https://github.com/vite-hub/vitehub/issues with the driver name and the message."),
    BLOB_R0018: withFix("Run `vitehub provision run --provider cloudflare` or `vitehub provision run --provider vercel` again. If it fails again, check the provider status and the API token, then report it at https://github.com/vite-hub/vitehub/issues with the message."),
    BLOB_R0019: withFix("Run `vitehub provision run --provider vercel` again. If it fails again, check the provider status and the API token, then report it at https://github.com/vite-hub/vitehub/issues with the message."),
    BLOB_R0020: withFix("In the Vercel dashboard, connect the Blob store to the project for the Production, Preview, and Development environments. Then run `vitehub provision run --provider vercel` again."),
    BLOB_R0021: withFix("In the Vercel dashboard, connect the Blob store to the project for the Production, Preview, and Development environments. Then run `vitehub provision run --provider vercel` again."),
    BLOB_R0022: withFix("Run `vitehub provision run --provider vercel` again. If it fails again, check the provider status and the API token, then report it at https://github.com/vite-hub/vitehub/issues with the message."),
    BLOB_R0023: withFix("Remove `blob: false` from the Vite config, or remove the `blob` calls from server code."),
    BLOB_R0024: withFix("Pass `expiresIn` in seconds as a positive integer, for example `blob.sign(pathname, { method: \"GET\", expiresIn: 300 })`."),
    BLOB_R0025: withFix("Use a driver that can sign this request, or remove the option that the message names. `cloudflare-r2` binds `createOnly`, `fs` binds `maxSize`, and drivers such as `s3` bind neither. For a `GET`, you can also serve the object through `blob.serve` instead of a signed URL."),
    BLOB_R0026: withFix("Call `store()` on the `blob` export, for example `blob.store(\"media\")`, not on a handle that `blob.store()` returned."),
    BLOB_R0028: withFix("Use one of the store names that the message lists, or add the store to `blob.stores` in the Vite config, for example `stores: { default: { driver: \"fs\" }, media: { driver: \"fs\" } }`."),
    BLOB_R0029: withFix("Change the command as the message says. `vitehub blob <command> --help` lists the arguments and options."),
    BLOB_R0030: withFix("Use the `fs`, `cloudflare-r2`, or `vercel-blob` driver for multipart uploads. On `cloudflare-r2`, run with the R2 binding, because the R2 HTTP API has no multipart support. Or upload the file with one `blob.put()`."),
    BLOB_R0031: withFix("Pass a `partNumber` from 1 to 10000 to `uploadPart()`. Number the parts from 1 in upload order."),
    BLOB_R0032: withFix("Pass the `pathname` and `uploadId` that `blob.createMultipartUpload()` returned to `blob.resumeMultipartUpload()`, and pass the parts that `uploadPart()` returned to `complete()`. A completed or aborted upload does not exist anymore. Start a new one."),
    BLOB_R0033: withFix("Use a pathname or folder outside `_vitehub/derived` and `_vitehub/media`, where ViteHub keeps image variants and media records. If the message is about an R2 list page, retry, and report it at https://github.com/vite-hub/vitehub/issues if it fails again."),
    BLOB_R0034: withFix("For a pathname, pass a non-empty pathname that names an object. For a pathname or prefix, remove control characters, broken Unicode, and `.` or `..` segments. For an image transformer, install the package that the message names, for example `pnpm add sharp` or `pnpm add @cf-wasm/photon`, or add the Cloudflare Images binding to the Worker. Its name is `IMAGES`, or the value of `blob.images.binding`."),
    BLOB_R0035: withFix("Change the argument of the `media` call as the message says. For example, a crop name has letters, digits, `_`, or `-`, and a crop aspect looks like `\"16:9\"`."),
    BLOB_R0036: withFix("Use a JPEG, PNG, WebP, or GIF image within the limits that the message names, and request `webp`, `jpeg`, or `png`, not AVIF. For larger images, set `blob.images.transformer` to `\"sharp\"` or `\"cloudflare-images\"`."),
    BLOB_R0037: withFix("Call `sign()` with `method: \"PUT\"` on a writable handle from `blob.store(name)`. A handle from `blob.store(name, { mode: \"read\" })` signs `GET` requests only."),
    BLOB_R0038: withFix("Pass `{ mode: \"read\" }` or `{ mode: \"write\" }` to `blob.store(name, options)`, or omit `mode` for a writable handle."),
    BLOB_R0039: withFix("Pass `maxSize` as a whole number and a unit, for example `\"8MB\"`. The units are `B`, `KB`, `MB`, and `GB`."),
    BLOB_R0040: withFix("Set `VITEHUB_SECRET` in the runtime environment to at least 32 characters. Generate one with `openssl rand -base64 32`. Give every instance that serves the store the same value."),
    BLOB_R0041: withFix("Send the request with the `method`, `url`, and `headers` that `blob.sign()` returned, unchanged. The server that answers must have the same `VITEHUB_SECRET` as the server that signed the link."),
    BLOB_R0042: withFix("Sign a new link with `blob.sign()`. Pass a larger `expiresIn` when the client needs more time."),
    BLOB_R0043: withFix("Send a smaller body, or sign the link with a larger `maxSize`."),
    BLOB_R0044: withFix("Set the env variable that the message names in the server environment, with the same value as at build time. The Blob config read it from `process.env` at build time, and ViteHub reads it again at runtime."),
  },
})
