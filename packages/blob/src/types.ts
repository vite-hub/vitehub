export interface BlobConfigSource {
  source?: "auto" | "explicit"
}

export interface CloudflareR2BlobConfig {
  bucketName?: string
  binding?: string
  driver: "cloudflare-r2"
  jurisdiction?: string
}

export interface VercelBlobConfig {
  access?: "public"
  driver: "vercel-blob"
  token?: string
}

export interface ResolvedCloudflareR2BlobConfig extends CloudflareR2BlobConfig, BlobConfigSource {
  binding: string
}

export interface ResolvedVercelBlobConfig extends VercelBlobConfig, BlobConfigSource {
  access: "public"
}

export type BlobProviderConfig = CloudflareR2BlobConfig | VercelBlobConfig

export type ResolvedBlobProviderConfig = ResolvedCloudflareR2BlobConfig | ResolvedVercelBlobConfig

export type BlobModuleOptions = BlobProviderConfig | Record<string, never> | false

export interface ResolvedBlobModuleOptions {
  provider: ResolvedBlobProviderConfig
}
