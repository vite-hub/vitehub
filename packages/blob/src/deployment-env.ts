import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { isMaskedBlobRuntimeValue } from "./config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { ResolvedBlobStoreConfig } from "./types.ts"

const owners = ["blob"]

function entry(names: readonly string[], required: boolean, secret = true): DeploymentEnvEntry {
  return { names, required, secret, hasDefault: false, owners }
}

// The names that the drivers read when the config left a credential to the env. They match `config.ts` and the drivers.
const r2CredentialNames = { accessKeyId: ["R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"], secretAccessKey: ["R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"] } as const
const minioCredentialNames = {
  accessKeyId: ["MINIO_ACCESS_KEY_ID", "MINIO_ACCESS_KEY", "MINIO_ROOT_USER", "AWS_ACCESS_KEY_ID"],
  secretAccessKey: ["MINIO_SECRET_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD", "AWS_SECRET_ACCESS_KEY"],
} as const

function storeEntries(store: ResolvedBlobStoreConfig, host: DeploymentEnvContext["host"]): DeploymentEnvEntry[] {
  const secretEnv = store.secretEnv ?? {}
  switch (store.driver) {
    case "vercel-blob": {
      if (!isMaskedBlobRuntimeValue(store.token)) return []
      // A token in the config reads only `BLOB_READ_WRITE_TOKEN`. Else Vercel OIDC with `BLOB_STORE_ID` comes first.
      return [entry(store.tokenFromConfig ? ["BLOB_READ_WRITE_TOKEN"] : ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"], true)]
    }
    case "cloudflare-r2": {
      // The binding does not use the HTTP credentials. The driver reads them for signed URLs, or without a binding.
      const required = host !== "cloudflare"
      return (["accessKeyId", "secretAccessKey"] as const).map(option => entry(secretEnv[option] ? [secretEnv[option]] : r2CredentialNames[option], required))
    }
    case "minio":
      return (["accessKeyId", "secretAccessKey"] as const).flatMap(option => secretEnv[option]
        ? [entry([secretEnv[option]], true)]
        : isMaskedBlobRuntimeValue(store[option]) ? [entry(minioCredentialNames[option], true)] : [])
    case "fs":
      // Signed links of an `fs` store use a key derived from `VITEHUB_SECRET`.
      return [entry(["VITEHUB_SECRET"], false)]
    default:
      // A credential that the config read from env is in `secretEnv`, and the driver needs it.
      return Object.values(secretEnv).map(name => entry([name], true))
  }
}

/**
 * The variables that the Blob stores read on the deployed host: the Vercel Blob credentials, the R2 HTTP or MinIO
 * credentials, `VITEHUB_SECRET` for the signed links of `fs` stores, and every credential that the config read from env.
 */
export function blobDeploymentEnv(config: BlobViteRuntimeConfig["blob"], context: DeploymentEnvContext): DeploymentEnvEntry[] {
  if (!config) return []
  return Object.values(config.stores ?? { default: config.store }).flatMap(store => storeEntries(store, context.host))
}
