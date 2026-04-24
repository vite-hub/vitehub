import type { Nitro, NitroRuntimeConfig } from 'nitro/types'

type BlobProviderPublicType = NonNullable<NonNullable<NitroRuntimeConfig['public']>['vitehub']>['blobProvider']

export interface ViteHubPublicRuntimeConfig extends Record<string, unknown> {
  vitehub?: Record<string, unknown> & {
    blobProvider?: BlobProviderPublicType
  }
}

export interface MutableNitroRuntimeConfig extends NitroRuntimeConfig {
  hosting?: string
  public?: ViteHubPublicRuntimeConfig
}

export type MutableFeatureNitroOptions<TOptions extends object = Record<string, never>> = Nitro['options'] & TOptions & {
  runtimeConfig?: MutableNitroRuntimeConfig
}

export type NitroStorageMount = Record<string, unknown>

export interface WranglerKVNamespace {
  binding: string
  id?: string
  preview_id?: string
  experimental_remote?: boolean
}

export interface WranglerR2Bucket {
  binding: string
  bucket_name?: string
  preview_bucket_name?: string
  jurisdiction?: string
  experimental_remote?: boolean
}

export interface WranglerContainer {
  class_name: string
  image?: string
  instance_type?: string
  max_instances?: number
}

export interface WranglerWorkerLoader {
  binding: string
}

export interface WranglerDurableObjectBinding {
  name: string
  class_name: string
}

export interface WranglerMigration {
  tag: string
  new_sqlite_classes?: string[]
}

export interface WranglerWorkflow {
  binding: string
  name: string
  class_name: string
}

export interface WranglerD1Database {
  binding: string
  database_name?: string
  database_id?: string
  preview_database_id?: string
  migrations_table?: string
  migrations_dir?: string
  database_internal_env?: string
  experimental_remote?: boolean
}

export interface WranglerAnalyticsEngineDataset {
  binding: string
  dataset?: string
}

export interface WranglerHyperdriveBinding {
  binding: string
  id: string
}

export interface MutableWranglerConfig {
  kv_namespaces?: WranglerKVNamespace[]
  r2_buckets?: WranglerR2Bucket[]
  containers?: WranglerContainer[]
  worker_loaders?: WranglerWorkerLoader[]
  durable_objects?: {
    bindings?: WranglerDurableObjectBinding[]
  }
  migrations?: WranglerMigration[]
  workflows?: WranglerWorkflow[]
  d1_databases?: WranglerD1Database[]
  analytics_engine_datasets?: WranglerAnalyticsEngineDataset[]
  hyperdrive?: WranglerHyperdriveBinding[]
}

export interface MutableCloudflareTarget {
  cloudflare?: {
    wrangler?: MutableWranglerConfig
  }
}

export interface MutableRollupTarget {
  rollupConfig?: {
    plugins?: unknown
  }
}

export interface MutableStorageTarget extends MutableCloudflareTarget {
  dev?: boolean
  storage?: Record<string, NitroStorageMount>
  devStorage?: Record<string, NitroStorageMount>
}
