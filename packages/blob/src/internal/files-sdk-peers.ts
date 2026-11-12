import type { BlobDriver } from "../types.ts"

const s3Peers = ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"] as const

export const filesSdkDriverPeers = {
  azure: ["@azure/identity", "@azure/storage-blob"],
  "cloudflare-r2": s3Peers,
  fs: [],
  gcs: ["@google-cloud/storage"],
  minio: s3Peers,
  "netlify-blobs": [],
  s3: s3Peers,
  "vercel-blob": [],
} satisfies Record<BlobDriver, readonly string[]>

export function getFilesSdkPeerInstall(driver: BlobDriver) {
  return filesSdkDriverPeers[driver].join(" ")
}

// The app installs the SDK of each driver it configures. Resolve from this package,
// because the bundled driver code imports the SDK from here.
export function findMissingFilesSdkPeers(
  drivers: Iterable<BlobDriver>,
  resolvePeer: (id: string) => unknown = id => import.meta.resolve(id),
  skipDrivers: Iterable<BlobDriver> = [],
): Array<{ driver: BlobDriver, peers: string[] }> {
  const skipped = new Set(skipDrivers)
  const missing: Array<{ driver: BlobDriver, peers: string[] }> = []
  for (const driver of new Set(drivers)) {
    if (skipped.has(driver)) continue
    const peers = filesSdkDriverPeers[driver].filter(id => !isInstalled(id, resolvePeer))
    if (peers.length) missing.push({ driver, peers })
  }
  return missing
}

function isInstalled(id: string, resolvePeer: (id: string) => unknown) {
  try {
    resolvePeer(id)
    return true
  }
  catch (error) {
    // A package without a root export is still installed.
    return (error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
  }
}
