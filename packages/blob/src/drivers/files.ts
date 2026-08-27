import { importOptionalPeer } from "../internal/optional-peer.ts"
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

const s3PeerInstall = "files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner"

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
      return (await importOptionalPeer<typeof import("files-sdk/akamai")>("files-sdk/akamai", options.driver, "files-sdk")).akamai(options)
    case "azure":
      return (await importOptionalPeer<typeof import("files-sdk/azure")>("files-sdk/azure", options.driver, "files-sdk")).azure(options)
    case "box":
      return (await importOptionalPeer<typeof import("files-sdk/box")>("files-sdk/box", options.driver, "files-sdk")).box(options)
    case "cloudflare-r2":
      return (await importOptionalPeer<typeof import("files-sdk/r2")>("files-sdk/r2", options.driver, "files-sdk")).r2({
        ...options,
        binding: getCloudflareBinding(options),
        bucket: options.bucketName,
      } as never)
    case "digitalocean-spaces":
      return (await importOptionalPeer<typeof import("files-sdk/digitalocean-spaces")>("files-sdk/digitalocean-spaces", options.driver, "files-sdk")).digitaloceanSpaces(options)
    case "dropbox":
      return (await importOptionalPeer<typeof import("files-sdk/dropbox")>("files-sdk/dropbox", options.driver, "files-sdk")).dropbox(options)
    case "fs":
      return (await importOptionalPeer<typeof import("files-sdk/fs")>("files-sdk/fs", options.driver, "files-sdk")).fs({
        ...(options as ResolvedFsBlobStoreConfig),
        root: options.base,
      })
    case "gcs":
      return (await importOptionalPeer<typeof import("files-sdk/gcs")>("files-sdk/gcs", options.driver, "files-sdk")).gcs(options)
    case "google-drive":
      return (await importOptionalPeer<typeof import("files-sdk/google-drive")>("files-sdk/google-drive", options.driver, "files-sdk")).googleDrive(options)
    case "hetzner":
      return (await importOptionalPeer<typeof import("files-sdk/hetzner")>("files-sdk/hetzner", options.driver, "files-sdk")).hetzner(options)
    case "minio":
      return (await importOptionalPeer<typeof import("files-sdk/minio")>("files-sdk/minio", options.driver, s3PeerInstall)).minio(options)
    case "onedrive":
      return (await importOptionalPeer<typeof import("files-sdk/onedrive")>("files-sdk/onedrive", options.driver, "files-sdk")).onedrive(options)
    case "s3":
      return (await importOptionalPeer<typeof import("files-sdk/s3")>("files-sdk/s3", options.driver, s3PeerInstall)).s3(options)
    case "storj":
      return (await importOptionalPeer<typeof import("files-sdk/storj")>("files-sdk/storj", options.driver, "files-sdk")).storj(options)
    case "supabase":
      return (await importOptionalPeer<typeof import("files-sdk/supabase")>("files-sdk/supabase", options.driver, "files-sdk")).supabase(options)
    case "uploadthing":
      return (await importOptionalPeer<typeof import("files-sdk/uploadthing")>("files-sdk/uploadthing", options.driver, "files-sdk")).uploadthing(options)
  }
}

export function createDriver(options: ResolvedBlobStoreConfig): BlobDriverAdapter<ResolvedBlobStoreConfig> {
  if (options.driver === "netlify-blobs") return createNetlifyBlobsDriver(options)
  if (options.driver === "vercel-blob") return createVercelBlobDriver(options)
  return createFilesSdkDriver(options, createAdapter)
}
