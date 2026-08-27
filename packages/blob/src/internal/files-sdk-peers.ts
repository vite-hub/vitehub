import type { BlobDriver } from "../types.ts"

const s3Peers = ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"] as const

export const filesSdkDriverPeers = {
  akamai: s3Peers,
  azure: ["@azure/storage-blob"],
  box: ["box-typescript-sdk-gen"],
  "cloudflare-r2": s3Peers,
  "digitalocean-spaces": s3Peers,
  dropbox: ["dropbox"],
  fs: [],
  gcs: ["@google-cloud/storage"],
  "google-drive": ["@googleapis/drive", "google-auth-library"],
  hetzner: s3Peers,
  minio: s3Peers,
  "netlify-blobs": [],
  onedrive: ["@azure/identity", "@microsoft/microsoft-graph-client"],
  s3: s3Peers,
  storj: s3Peers,
  supabase: ["@supabase/storage-js"],
  uploadthing: ["uploadthing"],
  "vercel-blob": [],
} satisfies Record<BlobDriver, readonly string[]>

export function getFilesSdkPeerInstall(driver: BlobDriver) {
  return filesSdkDriverPeers[driver].join(" ")
}
