import { defu } from "defu"

import { readEnv, trimmed } from "@vite-hub/internal/env"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type {
  BlobOptions,
  BlobStoreConfig,
  BlobStoresConfig,
  CloudflareR2BlobStoreConfig,
  CloudflareR2Jurisdiction,
  FsBlobStoreConfig,
  MinioBlobStoreConfig,
  NetlifyBlobsStoreConfig,
  ResolvedBlobModuleOptions,
  ResolvedBlobStoreConfig,
  ResolvedCloudflareR2BlobStoreConfig,
  ResolvedFsBlobStoreConfig,
  ResolvedMinioBlobStoreConfig,
  ResolvedVercelBlobStoreConfig,
  VercelBlobStoreConfig,
  BlobServeOptions,
} from "./types.ts"
import type { BlobImagesOptions } from "./media/types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { DEFAULT_BLOB_SERVE_ROUTE } from "./served.ts"

export { DEFAULT_BLOB_SERVE_ROUTE }

export interface BlobResolutionInput {
  /** True for `vite dev`, where a store's `remote` switch applies. */
  dev?: boolean
  env?: Record<string, string | undefined>
  hosting?: string
  /** The integration picked the `driver` from the deployment preset, so `vite dev` treats it like an inferred store. */
  presetDriver?: boolean
}

export const MASKED_BLOB_RUNTIME_VALUE = "********"
const DEFAULT_MINIO_BUCKET = "vitehub-blob"
const DEFAULT_MINIO_ENDPOINT = "http://localhost:9000"
const DEFAULT_MINIO_REGION = "us-east-1"
const DEFAULT_NETLIFY_BLOBS_STORE = "vitehub-blob"
const MINIO_ACCESS_KEY_ENV = ["MINIO_ACCESS_KEY_ID", "MINIO_ACCESS_KEY", "MINIO_ROOT_USER", "AWS_ACCESS_KEY_ID"] as const
const MINIO_SECRET_KEY_ENV = ["MINIO_SECRET_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD", "AWS_SECRET_ACCESS_KEY"] as const

const S3_COMPATIBLE_OPTIONS = (prefix: string): BlobDriverOptions => ({
  options: ["bucket", "endpoint", "publicBaseUrl", "region"],
  secrets: { accessKeyId: `${prefix}_ACCESS_KEY_ID`, secretAccessKey: `${prefix}_SECRET_ACCESS_KEY` },
})

interface BlobDriverOptions {
  /** The string options that are not credentials, by option path. */
  options: readonly string[]
  /** The credential options, by option path, with an example env variable for the `BLOB_C0019` message. */
  secrets: Record<string, string>
}

/**
 * The string options of each driver. ViteHub writes the resolved config into the server bundle, so it writes only the
 * options in `options`. Every other string option, also one that the driver types do not have, is a credential. Its
 * value must come from an env variable.
 */
const BLOB_DRIVER_OPTIONS: Record<BlobStoreConfig["driver"], BlobDriverOptions> = {
  azure: {
    options: ["accountName", "container", "endpoint", "publicBaseUrl"],
    secrets: { accountKey: "AZURE_STORAGE_KEY", connectionString: "AZURE_STORAGE_CONNECTION_STRING", sasToken: "AZURE_STORAGE_SAS_TOKEN" },
  },
  "cloudflare-r2": { ...S3_COMPATIBLE_OPTIONS("R2"), options: ["accountId", "binding", "bucketName", "jurisdiction", "publicBaseUrl"] },
  fs: { options: ["base", "urlBaseUrl"], secrets: {} },
  gcs: {
    options: ["bucket", "credentials.client_email", "keyFilename", "projectId", "publicBaseUrl"],
    secrets: { "credentials.private_key": "GCS_PRIVATE_KEY" },
  },
  minio: S3_COMPATIBLE_OPTIONS("MINIO"),
  "netlify-blobs": { options: ["consistency", "name", "siteID"], secrets: { token: "NETLIFY_AUTH_TOKEN" } },
  s3: {
    options: ["bucket", "endpoint", "publicBaseUrl", "region"],
    secrets: { "credentials.accessKeyId": "AWS_ACCESS_KEY_ID", "credentials.secretAccessKey": "AWS_SECRET_ACCESS_KEY", "credentials.sessionToken": "AWS_SESSION_TOKEN" },
  },
  "vercel-blob": { options: ["access"], secrets: { token: "BLOB_READ_WRITE_TOKEN" } },
}

/** Options that ViteHub sets itself and that hold no credential. */
const RESOLVED_STORE_OPTIONS = new Set(["driver", "localFallback", "secretEnv"])

/** The R2 HTTP credentials. The binding does not use them, so the R2 driver reads them only when it needs them. */
const LAZY_R2_SECRETS = new Set(["accessKeyId", "secretAccessKey"])

function withOptionPath(target: Record<string, unknown>, [key, ...rest]: string[], value: string): Record<string, unknown> {
  if (!key) return target
  const current = target[key]
  return { ...target, [key]: rest.length ? withOptionPath(isPlainObject(current) ? current : {}, rest, value) : value }
}

/** The string and array options of a store, by option path. ViteHub cannot hide a value in an array, so an array is a credential that fails. */
function readStringOptions(value: Record<string, unknown>, prefix = ""): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, option]): Array<[string, unknown]> => {
    if (!prefix && RESOLVED_STORE_OPTIONS.has(key)) return []
    const path = `${prefix}${key}`
    if (isPlainObject(option)) return readStringOptions(option, `${path}.`)
    return typeof option === "string" || Array.isArray(option) ? [[path, option]] : []
  })
}

/** A URL with a user name, password, or query, such as an Azure endpoint with a SAS token, holds a credential. */
function isCredentialUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return Boolean(url.username || url.password || url.search)
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" })

/**
 * Replaces each credential option with the mask and records the env variable that holds its value at build time, so
 * the generated output has no secret. The value must be in exactly one env variable: a literal value fails with
 * `BLOB_C0019`, and a value in more than one variable fails with `BLOB_C0020`.
 */
function hideConfiguredSecrets(
  store: ResolvedBlobStoreConfig,
  env: Record<string, string | undefined>,
  path: string,
): ResolvedBlobStoreConfig {
  const { options, secrets } = BLOB_DRIVER_OPTIONS[store.driver]
  const secretEnv: Record<string, string> = {}
  let hidden: Record<string, unknown> = { ...store }
  for (const [option, raw] of readStringOptions(hidden)) {
    const value = typeof raw === "string" ? raw.trim() : undefined
    if (value === "" || value === MASKED_BLOB_RUNTIME_VALUE) continue
    const example = secrets[option]
    const known = options.includes(option)
    if (known && value && !isCredentialUrl(value)) continue
    const reason = example
      ? `\`${path}.${option}\` is a literal credential`
      : known
        ? `\`${path}.${option}\` holds a credential, because it is a URL with a user name, password, or query`
        : `\`${path}.${option}\` is not a known option of the ${store.driver} driver, so ViteHub treats it as a credential`
    const names = value ? Object.keys(env).filter(name => trimmed(env[name]) === value).sort() : []
    if (names.length > 1) {
      throw blobErrorDiagnostics.BLOB_C0020({ message: `${reason}, and ${listFormat.format(names.map(name => `\`${name}\``))} hold its value at build time. ViteHub cannot tell which variable the config reads.` })
    }
    const [name] = names
    if (!name) {
      throw blobErrorDiagnostics.BLOB_C0019({ message: `${reason}: no variable in \`process.env\` holds its value when the Vite config loads. ViteHub does not write credentials into the build output. Read it from an env variable${example ? `, for example \`process.env.${example}\`` : ""}.` })
    }
    secretEnv[option] = name
    hidden = withOptionPath(hidden, option.split("."), MASKED_BLOB_RUNTIME_VALUE)
  }
  if (!Object.keys(secretEnv).length) return store
  // SAFETY: Only string options of the same driver changed to the mask, so the store keeps its driver-specific shape.
  return { ...hidden, secretEnv } as ResolvedBlobStoreConfig
}

/** Reads a credential from the env variable that `hideConfiguredSecrets()` recorded, or fails with `BLOB_R0044`. */
export function readBlobSecretEnv(env: Record<string, string | undefined>, name: string, option: string, driver: string): string {
  const value = readEnv(env, name)
  if (!value) {
    throw blobErrorDiagnostics.BLOB_R0044({ message: `Missing runtime environment variable \`${name}\` for the \`${option}\` option of the ${driver} Blob store.` })
  }
  return value
}

/**
 * Reads at runtime the credentials that `hideConfiguredSecrets()` replaced with an env variable name. It keeps the R2
 * HTTP credentials in `secretEnv`: the R2 driver reads them only without an active binding or to sign a URL.
 *
 * @example
 * resolveRuntimeBlobSecrets({ driver: "s3", bucket: "assets", credentials: { accessKeyId: "********", secretAccessKey: "********" }, secretEnv: { "credentials.accessKeyId": "S3_KEY", "credentials.secretAccessKey": "S3_SECRET" } }, process.env)
 * // { driver: "s3", bucket: "assets", credentials: { accessKeyId: process.env.S3_KEY, secretAccessKey: process.env.S3_SECRET } }
 */
export function resolveRuntimeBlobSecrets<TStore extends ResolvedBlobStoreConfig>(
  store: TStore,
  env: Record<string, string | undefined>,
): TStore {
  const { secretEnv, ...config } = store
  if (!secretEnv) return store
  const lazy: Record<string, string> = {}
  let resolved: Record<string, unknown> = config
  for (const [option, name] of Object.entries(secretEnv)) {
    if (store.driver === "cloudflare-r2" && LAZY_R2_SECRETS.has(option)) lazy[option] = name
    else resolved = withOptionPath(resolved, option.split("."), readBlobSecretEnv(env, name, option, store.driver))
  }
  // SAFETY: Only the masked string options changed to their runtime values, so the store keeps its shape.
  return (Object.keys(lazy).length ? { ...resolved, secretEnv: lazy } : resolved) as TStore
}

function resolveFsStore(
  config: Partial<FsBlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedFsBlobStoreConfig {
  const urlBaseUrl = trimmed(config.urlBaseUrl)
  return defu({ base: trimmed(config.base) ?? readEnv(env, "BLOB_FS_BASE"), ...(urlBaseUrl ? { urlBaseUrl } : {}) }, { base: ".vitehub/data/blob", driver: "fs" as const })
}

const CLOUDFLARE_R2_JURISDICTIONS = { eu: true, fedramp: true, us: true } satisfies Record<CloudflareR2Jurisdiction, true>

function resolveCloudflareJurisdiction(
  value: unknown,
  env: Record<string, string | undefined>,
): CloudflareR2Jurisdiction | undefined {
  const source = value ?? readEnv(env, "R2_JURISDICTION", "CLOUDFLARE_R2_JURISDICTION")
  if (source === undefined) return
  const jurisdiction = trimmed(source)
  if (!jurisdiction || !Object.hasOwn(CLOUDFLARE_R2_JURISDICTIONS, jurisdiction)) {
    throw blobErrorDiagnostics.BLOB_C0014({ message: `Cloudflare R2 \`jurisdiction\` must be "eu", "fedramp", or "us". Received ${JSON.stringify(source)}.` })
  }
  // SAFETY: The own-property check above limits the value to a key of the jurisdiction record.
  return jurisdiction as CloudflareR2Jurisdiction
}

function resolveCloudflareStore(
  config: Partial<CloudflareR2BlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareR2BlobStoreConfig {
  return defu(
    {
      ...config,
      accountId: resolveBuildRuntimeValue(config.accountId, env, "R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"),
      accessKeyId: resolveBuildRuntimeValue(config.accessKeyId, env, "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"),
      binding: trimmed(config.binding),
      bucketName: trimmed(config.bucketName) ?? readEnv(env, "BLOB_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME", "R2_BUCKET_NAME"),
      jurisdiction: resolveCloudflareJurisdiction(config.jurisdiction, env),
      secretAccessKey: resolveBuildRuntimeValue(config.secretAccessKey, env, "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
    { binding: "BLOB", driver: "cloudflare-r2" as const },
  )
}

/**
 * Vercel Blob sets access on each object, and a public object has a public provider URL. So a store is private unless
 * its config sets `access: "public"` or an `access: "public"` serve route serves it.
 */
function resolveVercelAccess(
  config: Partial<VercelBlobStoreConfig>,
  served: ResolvedBlobModuleOptions["serve"],
  path: string,
): ResolvedVercelBlobStoreConfig["access"] {
  if (config.access === "public" && served?.authorize) {
    throw blobErrorDiagnostics.BLOB_C0022({ message: `\`${path}.access\` is "public", but \`blob.serve\` requires \`authorize: true\` for this store. Anyone could read its objects from their public Vercel Blob URLs.` })
  }
  return config.access ?? served?.access ?? "private"
}

function resolveVercelStore(
  config: Partial<VercelBlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
  served?: ResolvedBlobModuleOptions["serve"],
  path = "blob",
): ResolvedVercelBlobStoreConfig {
  const token = resolveBuildRuntimeValue(config.token, env, "BLOB_READ_WRITE_TOKEN") ?? MASKED_BLOB_RUNTIME_VALUE
  return {
    ...config,
    access: resolveVercelAccess(config, served, path),
    driver: "vercel-blob",
    token,
    ...(token === MASKED_BLOB_RUNTIME_VALUE && trimmed(config.token) ? { tokenFromConfig: true } : {}),
  }
}

function resolveNetlifyStore(
  config: Partial<NetlifyBlobsStoreConfig> = {},
): NetlifyBlobsStoreConfig {
  return {
    ...config,
    driver: "netlify-blobs",
    name: trimmed(config.name) ?? DEFAULT_NETLIFY_BLOBS_STORE,
  }
}

function resolveBuildRuntimeValue(
  configValue: string | undefined,
  env: Record<string, string | undefined>,
  ...envNames: string[]
): string | undefined {
  const explicit = trimmed(configValue)
  if (!explicit) return readEnv(env, ...envNames) ? MASKED_BLOB_RUNTIME_VALUE : undefined
  return envNames.some(name => trimmed(env[name]) === explicit) ? MASKED_BLOB_RUNTIME_VALUE : explicit
}

function resolveMinioStore(
  config: Partial<MinioBlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedMinioBlobStoreConfig {
  return {
    ...config,
    accessKeyId: resolveBuildRuntimeValue(config.accessKeyId, env, ...MINIO_ACCESS_KEY_ENV),
    bucket: trimmed(config.bucket) ?? readEnv(env, "BLOB_BUCKET_NAME", "MINIO_BUCKET", "MINIO_BUCKET_NAME") ?? DEFAULT_MINIO_BUCKET,
    driver: "minio",
    endpoint: trimmed(config.endpoint) ?? readEnv(env, "MINIO_ENDPOINT") ?? DEFAULT_MINIO_ENDPOINT,
    forcePathStyle: config.forcePathStyle ?? true,
    region: trimmed(config.region) ?? readEnv(env, "MINIO_REGION", "AWS_REGION") ?? DEFAULT_MINIO_REGION,
    secretAccessKey: resolveBuildRuntimeValue(config.secretAccessKey, env, ...MINIO_SECRET_KEY_ENV),
  }
}

function resolveExplicitStore(
  store: BlobStoreConfig,
  env: Record<string, string | undefined>,
  served: ResolvedBlobModuleOptions["serve"],
  path: string,
) {
  switch (store.driver) {
    case "cloudflare-r2":
      return resolveCloudflareStore(store, env)
    case "fs":
      return resolveFsStore(store, env)
    case "minio":
      return resolveMinioStore(store, env)
    case "netlify-blobs":
      return resolveNetlifyStore(store)
    case "vercel-blob":
      return resolveVercelStore(store, env, served, path)
    case "azure":
    case "gcs":
    case "s3":
      return store
    default:
      // SAFETY: The invalid driver branch reads only the driver field for diagnostics, without using it as a supported driver.
      throw blobErrorDiagnostics.BLOB_C0001({ message: `Unknown \`blob.driver\`: ${JSON.stringify((store as { driver: unknown }).driver)}.` })
  }
}

function normalizeServeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return
  if (!isPlainObject(value)) throw blobErrorDiagnostics.BLOB_C0002({ message: "`blob.serve.headers` must be a plain object." })

  const entries = Object.entries(value)
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string") throw blobErrorDiagnostics.BLOB_C0003({ message: "`blob.serve.headers` values must be strings." })
    try {
      new Headers({ [name]: headerValue })
    }
    catch {
      throw blobErrorDiagnostics.BLOB_C0004({ message: `\`blob.serve.headers\` contains an invalid HTTP header: ${JSON.stringify(name)}.` })
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function normalizeServeOptions(value: false | BlobServeOptions | undefined): ResolvedBlobModuleOptions["serve"] {
  if (value === undefined || value === false) return
  if (!isPlainObject(value)) {
    throw blobErrorDiagnostics.BLOB_C0005({ message: `\`blob.serve\` must be a plain object that says who may read the files. Received ${JSON.stringify(value)}.` })
  }
  if (value.authorize !== undefined && value.authorize !== true && value.authorize !== false) {
    throw blobErrorDiagnostics.BLOB_C0012({ message: "`blob.serve.authorize` must be a boolean. Export an `authorize` function from `server/blob.ts` for per-request rules." })
  }
  if ("public" in value) {
    throw blobErrorDiagnostics.BLOB_C0021({ message: "`blob.serve.public` is not an option. Set `access: \"public\"` to serve the files to anyone." })
  }
  const authorize: unknown = value.authorize
  if (authorize === false) {
    throw blobErrorDiagnostics.BLOB_C0021({ message: "`blob.serve.authorize: false` does not make the route public. Set `access: \"public\"` to serve the files to anyone, or `authorize: true` to require sign-in." })
  }
  if (value.access !== undefined && value.access !== "public") {
    throw blobErrorDiagnostics.BLOB_C0021({ message: `\`blob.serve.access\` must be "public". Received ${JSON.stringify(value.access)}. Set \`authorize: true\` to require sign-in.` })
  }
  if (value.access && value.authorize) {
    throw blobErrorDiagnostics.BLOB_C0021({ message: "`blob.serve` sets both `access: \"public\"` and `authorize: true`. Choose one." })
  }
  if (!value.access && !value.authorize) {
    throw blobErrorDiagnostics.BLOB_C0021({ message: "`blob.serve` does not say who may read the files. The serve route sends every object of the store, so set `access: \"public\"` or `authorize: true`." })
  }
  if (value.anonymous !== undefined && value.anonymous !== true && value.anonymous !== false) {
    throw blobErrorDiagnostics.BLOB_C0016({ message: "`blob.serve.anonymous` must be a boolean." })
  }
  if (value.anonymous && !value.authorize) {
    throw blobErrorDiagnostics.BLOB_C0016({ message: "`blob.serve.anonymous` requires `blob.serve.authorize: true`. An `access: \"public\"` route already serves signed-out callers." })
  }
  const headers = normalizeServeHeaders(value.headers)
  return {
    ...(value.access ? { access: "public" } : {}),
    ...(value.anonymous ? { anonymous: true } : {}),
    ...(value.authorize ? { authorize: true } : {}),
    ...(headers ? { headers } : {}),
    route: trimmed(value.route) || DEFAULT_BLOB_SERVE_ROUTE,
    store: trimmed(value.store) || "default",
    ...(trimmed(value.publicBaseUrl) ? { publicBaseUrl: trimmed(value.publicBaseUrl) } : {}),
  }
}

const imageTransformers = ["auto", "cloudflare-images", "passthrough", "photon", "sharp"]

function normalizeImagesOptions(value: unknown): ResolvedBlobModuleOptions["images"] {
  if (value === undefined || value === false) return value
  const invalid = (message: string) => blobErrorDiagnostics.BLOB_C0015({ message })
  if (!isPlainObject(value)) throw invalid("`blob.images` must be false or a plain object.")
  // SAFETY: `value` is a plain object, and each field below is checked before it is copied.
  const { binding, quality, sizes, transformer } = value as BlobImagesOptions
  const images: BlobImagesOptions = {}
  if (transformer !== undefined) {
    if (!imageTransformers.includes(transformer)) throw invalid(`\`blob.images.transformer\` must be one of ${imageTransformers.join(", ")}.`)
    images.transformer = transformer
  }
  if (binding !== undefined) {
    if (!trimmed(binding)) throw invalid("`blob.images.binding` must be a non-empty Cloudflare binding name.")
    images.binding = trimmed(binding)
  }
  if (quality !== undefined) {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw invalid("`blob.images.quality` must be an integer from 1 to 100.")
    images.quality = quality
  }
  if (sizes !== undefined) {
    if (!Array.isArray(sizes) || !sizes.length || !sizes.every(size => Number.isInteger(size) && size >= 1 && size <= 10_000)) {
      throw invalid("`blob.images.sizes` must be a non-empty array of integers from 1 to 10000.")
    }
    images.sizes = [...new Set(sizes)].sort((left, right) => left - right)
  }
  return images
}

function servedRoute(serve: ResolvedBlobModuleOptions["serve"], store: string): ResolvedBlobModuleOptions["serve"] {
  return serve?.store === store ? serve : undefined
}

function assertServeStore(
  serve: ResolvedBlobModuleOptions["serve"],
  stores: Record<string, ResolvedBlobModuleOptions["store"]>,
): void {
  if (!serve || Object.hasOwn(stores, serve.store)) return
  throw blobErrorDiagnostics.BLOB_C0006({ message: `\`blob.serve.store\` must reference a configured Blob store: ${JSON.stringify(serve.store)}.` })
}

function createResolvedConfig(
  env: Record<string, string | undefined>,
  configuredStore: ResolvedBlobModuleOptions["store"],
  configuredStores?: Record<string, ResolvedBlobModuleOptions["store"]>,
  serve?: ResolvedBlobModuleOptions["serve"],
  images?: ResolvedBlobModuleOptions["images"],
): ResolvedBlobModuleOptions {
  const stores = configuredStores && Object.fromEntries(Object.entries(configuredStores).map(([name, store]) => [name, hideConfiguredSecrets(store, env, `blob.stores.${name}`)]))
  const store = stores?.default ?? hideConfiguredSecrets(configuredStore, env, "blob")
  assertServeStore(serve, stores ? { default: store, ...stores } : { default: store })
  const shared = { ...(serve ? { serve } : {}), ...(images === undefined ? {} : { images }) }
  return stores
    ? { store, stores: { default: store, ...stores }, ...shared }
    : { store, ...shared }
}

/** One store config from options that also carry module-level `serve` and `images`. */
function withoutModuleOptions(store: BlobStoreConfig): BlobStoreConfig {
  const copy = { ...store }
  Reflect.deleteProperty(copy, "serve")
  Reflect.deleteProperty(copy, "images")
  return copy
}

function hasStoresConfig(options: BlobOptions | undefined): options is BlobStoresConfig {
  if (!options || !Object.hasOwn(options, "stores")) return false
  // SAFETY: The own-property check above establishes that this read cannot come from an inherited prototype.
  return isPlainObject((options as { stores?: unknown }).stores)
}

// `BLOB_STORE_ID` marks a project connected to a store through Vercel OIDC.
export function hasVercelBlobEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(readEnv(env, "BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"))
}

function readRemote(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === true || value === false) return value
  throw blobErrorDiagnostics.BLOB_C0017({ message: `\`${path}\` must be true or false. Received ${JSON.stringify(value)}.` })
}

/**
 * Applies the `vite dev` switch between the local `fs` store and a hosted store. A Vercel Blob store that env or the
 * host preset picks becomes the local `fs` store unless it sets `remote: true`. An R2 store of the Cloudflare preset keeps
 * a dev runner's R2 binding, which is a local emulation, and uses `fs` without one. Netlify Blobs keeps the local sandbox
 * of `netlify dev`. An explicit `driver` is used as configured. Builds ignore `remote`.
 */
function applyDevelopmentMode(
  resolved: ResolvedBlobStoreConfig,
  options: { dev: boolean, env: Record<string, string | undefined>, inferred: boolean, path: string, remote: boolean | undefined },
): ResolvedBlobStoreConfig {
  const { remote: _remote, ...local } = resolved
  if (local.driver === "fs") {
    if (options.remote && (options.dev || !options.inferred)) {
      throw blobErrorDiagnostics.BLOB_C0018({ message: `\`${options.path}\` is true, but the store uses the local \`fs\` driver. Set a hosted \`driver\`, or remove \`remote\`.` })
    }
    return local
  }
  if (!options.dev) return local
  if (options.remote) return { ...local, remote: true }
  if (!options.inferred) return local
  if (local.driver === "vercel-blob") return resolveFsStore({}, options.env)
  if (local.driver === "cloudflare-r2") return { ...local, localFallback: resolveFsStore({}, options.env) }
  return local
}

export function normalizeBlobOptions(
  options: BlobOptions | undefined,
  input: BlobResolutionInput = {},
): ResolvedBlobModuleOptions | undefined {
  if (options === false) {
    return
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw blobErrorDiagnostics.BLOB_C0007({ message: "`blob` must be a plain object." })
  }

  const env = input.env || process.env
  const dev = input.dev === true
  const hosting = normalizeHosting(input.hosting)
  const explicit = options as BlobStoreConfig | undefined
  const optionRecord = options as { serve?: false | BlobServeOptions } | undefined
  // SAFETY: `options` was validated as a plain object above, so this assertion only narrows its optional `stores` property.
  const storesOption = (options as { stores?: unknown } | undefined)?.stores
  if (options !== undefined && Object.hasOwn(options, "stores") && storesOption !== undefined && !isPlainObject(storesOption)) {
    throw blobErrorDiagnostics.BLOB_C0013({ message: "`blob.stores` must be a plain object." })
  }
  const serve = normalizeServeOptions(optionRecord?.serve)
  const images = normalizeImagesOptions(options?.images)
  const { serve: _serve, images: _images, ...storeOptions } = options || {}
  const implicitCloudflare = storeOptions as Partial<CloudflareR2BlobStoreConfig> | undefined

  if (hasStoresConfig(options)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(options.stores).map(([name, store]) => {
        const path = `blob.stores.${name}.remote`
        const remote = readRemote(isPlainObject(store) ? store.remote : undefined, path)
        return [name, applyDevelopmentMode(resolveExplicitStore(store, env, servedRoute(serve, name), `blob.stores.${name}`), { dev, env, inferred: false, path, remote })]
      }),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw blobErrorDiagnostics.BLOB_C0008({ message: "`blob.stores.default` is required when using named Blob stores." })
    return createResolvedConfig(env, defaultStore, resolvedStores, serve, images)
  }

  const remote = readRemote(explicit?.remote, "blob.remote")
  const mode = { dev, env, inferred: !explicit?.driver || input.presetDriver === true, path: "blob.remote", remote }

  if (explicit?.driver) {
    return createResolvedConfig(env, applyDevelopmentMode(resolveExplicitStore(withoutModuleOptions(explicit), env, servedRoute(serve, "default"), "blob"), mode), undefined, serve, images)
  }

  if (hosting.includes("cloudflare")) {
    return createResolvedConfig(env, applyDevelopmentMode(resolveCloudflareStore(implicitCloudflare, env), mode), undefined, serve, images)
  }

  if (hosting.includes("netlify")) {
    return createResolvedConfig(env, applyDevelopmentMode(resolveNetlifyStore(), mode), undefined, serve, images)
  }

  if (hasVercelBlobEnv(env)) {
    return createResolvedConfig(env, applyDevelopmentMode(resolveVercelStore({}, env, servedRoute(serve, "default")), mode), undefined, serve, images)
  }

  if (hosting.includes("vercel")) {
    return createResolvedConfig(env, applyDevelopmentMode(resolveVercelStore({}, env, servedRoute(serve, "default")), mode), undefined, serve, images)
  }

  return createResolvedConfig(env, applyDevelopmentMode(resolveFsStore({}, env), mode), undefined, serve, images)
}

export function warnVercelBlobFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedBlobModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !normalizeHosting(hosting).includes("vercel")) return
  const stores = Object.values(config.stores || { default: config.store })
  if (!stores.some(store => store.driver === "fs")) return
  target.logger?.error?.("Vercel hosting requires Vercel Blob-backed storage. Connect a Blob store to the project (`BLOB_STORE_ID`) or set `BLOB_READ_WRITE_TOKEN`.")
}

export function isMaskedBlobRuntimeValue(value: string | undefined): boolean {
  return !value || value === MASKED_BLOB_RUNTIME_VALUE
}

/**
 * Resolves Vercel Blob credentials at runtime, in the order that Vercel documents:
 * a configured token, then OIDC with `BLOB_STORE_ID`, then `BLOB_READ_WRITE_TOKEN`.
 * For OIDC the store has no token, so `@vercel/blob` reads the OIDC token itself and
 * falls back to `BLOB_READ_WRITE_TOKEN` when no OIDC token exists, for example off Vercel.
 */
export function resolveRuntimeVercelBlobStore(
  config: ResolvedVercelBlobStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedVercelBlobStoreConfig {
  const { token: configuredToken, tokenFromConfig, ...store } = config
  if (!isMaskedBlobRuntimeValue(configuredToken)) return config
  if (!tokenFromConfig && readEnv(env, "BLOB_STORE_ID")) return store

  const token = readEnv(env, "BLOB_READ_WRITE_TOKEN")
  if (!token) {
    if (tokenFromConfig) {
      throw blobErrorDiagnostics.BLOB_C0009({ message: "Missing runtime environment variable `BLOB_READ_WRITE_TOKEN` for the configured Vercel Blob token." })
    }
    throw blobErrorDiagnostics.BLOB_C0009({ message: "Missing Vercel Blob credentials. Connect a Blob store to the Vercel project so it gets `BLOB_STORE_ID`, or set `BLOB_READ_WRITE_TOKEN` off Vercel." })
  }
  return { ...store, token }
}

export function resolveRuntimeMinioBlobStore(
  config: ResolvedMinioBlobStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedMinioBlobStoreConfig {
  const accessKeyId = isMaskedBlobRuntimeValue(config.accessKeyId)
    ? readEnv(env, ...MINIO_ACCESS_KEY_ENV) || config.accessKeyId
    : config.accessKeyId
  const secretAccessKey = isMaskedBlobRuntimeValue(config.secretAccessKey)
    ? readEnv(env, ...MINIO_SECRET_KEY_ENV) || config.secretAccessKey
    : config.secretAccessKey

  if (isMaskedBlobRuntimeValue(accessKeyId)) {
    throw blobErrorDiagnostics.BLOB_C0010({ message: "Missing runtime environment variable `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID` for MinIO Blob." })
  }

  if (isMaskedBlobRuntimeValue(secretAccessKey)) {
    throw blobErrorDiagnostics.BLOB_C0011({ message: "Missing runtime environment variable `MINIO_SECRET_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_ROOT_PASSWORD`, or `AWS_SECRET_ACCESS_KEY` for MinIO Blob." })
  }

  return {
    ...config,
    accessKeyId,
    secretAccessKey,
  }
}
