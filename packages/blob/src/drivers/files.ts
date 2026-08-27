import { getActiveCloudflareBinding } from "../runtime/state.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"
import { createDriver as createNetlifyBlobsDriver } from "./netlify-blobs.ts"
import { createDriver as createVercelBlobDriver } from "./vercel-bundled.ts"

import type {
  BlobDriverAdapter,
  ResolvedBlobStoreConfig,
  ResolvedCloudflareR2BlobStoreConfig,
  ResolvedFsBlobStoreConfig,
} from "../types.ts"
import type { Adapter } from "files-sdk"

function getCloudflareBinding(options: ResolvedCloudflareR2BlobStoreConfig) {
  const binding = getActiveCloudflareBinding(options.binding)
    || (globalThis as any)[options.binding]

  if (!binding) {
    throw new Error(`R2 binding "${options.binding}" not found`)
  }

  return binding
}

type FilesSdkBlobStoreConfig = Exclude<ResolvedBlobStoreConfig, { driver: "netlify-blobs" | "vercel-blob" }>

async function createAdapter(options: FilesSdkBlobStoreConfig): Promise<Adapter> {
  switch (options.driver) {
    case "akamai":
      return (await import("files-sdk/akamai")).akamai(options)
    case "azure":
      return (await import("files-sdk/azure")).azure(options)
    case "box":
      return (await import("files-sdk/box")).box(options)
    case "cloudflare-r2":
      return (await import("files-sdk/r2")).r2({
        ...options,
        binding: getCloudflareBinding(options),
        bucket: options.bucketName,
      } as never)
    case "digitalocean-spaces":
      return (await import("files-sdk/digitalocean-spaces")).digitaloceanSpaces(options)
    case "dropbox":
      return (await import("files-sdk/dropbox")).dropbox(options)
    case "fs":
      return (await import("files-sdk/fs")).fs({
        ...(options as ResolvedFsBlobStoreConfig),
        root: options.base,
      })
    case "gcs":
      return (await import("files-sdk/gcs")).gcs(options)
    case "google-drive":
      return (await import("files-sdk/google-drive")).googleDrive(options)
    case "hetzner":
      return (await import("files-sdk/hetzner")).hetzner(options)
    case "minio":
      return (await import("files-sdk/minio")).minio(options)
    case "onedrive":
      return (await import("files-sdk/onedrive")).onedrive(options)
    case "s3":
      return (await import("files-sdk/s3")).s3(options)
    case "storj":
      return (await import("files-sdk/storj")).storj(options)
    case "supabase":
      return (await import("files-sdk/supabase")).supabase(options)
    case "uploadthing":
      return (await import("files-sdk/uploadthing")).uploadthing(options)
  }
}

export function createDriver(options: ResolvedBlobStoreConfig): BlobDriverAdapter<ResolvedBlobStoreConfig> {
  if (options.driver === "netlify-blobs") return createNetlifyBlobsDriver(options)
  if (options.driver === "vercel-blob") return createVercelBlobDriver(options)
  return createFilesSdkDriver(options, createAdapter)
}
