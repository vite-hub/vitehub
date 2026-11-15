import { describe, expect, it } from "vitest"

import { blobDeploymentEnv } from "../src/deployment-env.ts"
import { resolveBlobViteConfig } from "../src/vite-config.ts"

const canary = "canary-value-0b3e"
const blob = (owners = ["blob"]) => ({ secret: true, hasDefault: false, owners })

describe("blobDeploymentEnv", () => {
  it("names the Vercel Blob credentials in read order, never their values", () => {
    const { blob: config } = resolveBlobViteConfig({ driver: "vercel-blob" }, { env: { BLOB_READ_WRITE_TOKEN: canary }, hosting: "vercel" })
    const entries = blobDeploymentEnv(config, { host: "vercel" })
    expect(entries).toEqual([{ names: ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"], required: true, ...blob() }])
    expect(JSON.stringify(entries)).not.toContain(canary)
  })

  it("names only BLOB_READ_WRITE_TOKEN for a token that the config reads", () => {
    const { blob: config } = resolveBlobViteConfig({ driver: "vercel-blob", token: canary }, { env: { BLOB_READ_WRITE_TOKEN: canary } })
    expect(blobDeploymentEnv(config, { host: "vercel" })).toEqual([{ names: ["BLOB_READ_WRITE_TOKEN"], required: true, ...blob() }])
  })

  it("keeps the R2 HTTP credentials optional next to the Cloudflare binding", () => {
    const { blob: config } = resolveBlobViteConfig({ driver: "cloudflare-r2", bucketName: "assets" }, { env: {} })
    expect(blobDeploymentEnv(config, { host: "cloudflare" })).toEqual([
      { names: ["R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"], required: false, ...blob() },
      { names: ["R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"], required: false, ...blob() },
      { names: ["R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"], required: false, ...blob() },
    ])
  })

  it.each(["node", "cloudflare"] as const)("declares an env-supplied R2 account ID on %s", (host) => {
    const { blob: config } = resolveBlobViteConfig({ driver: "cloudflare-r2", bucketName: "assets" }, {
      env: { R2_ACCOUNT_ID: canary, R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" },
    })
    const entries = blobDeploymentEnv(config, { host })
    expect(entries).toContainEqual({ names: ["R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"], required: host !== "cloudflare", ...blob() })
    expect(JSON.stringify(entries)).not.toContain(canary)
  })

  it("does not declare an env dependency for a literal R2 account ID", () => {
    const { blob: config } = resolveBlobViteConfig({ driver: "cloudflare-r2", bucketName: "assets", accountId: "literal-account" }, { env: {} })
    expect(blobDeploymentEnv(config, { host: "node" }).flatMap(entry => entry.names)).not.toContain("R2_ACCOUNT_ID")
  })

  it("names each credential that the config read from env", () => {
    const env = { S3_KEY: "canary-key-1", S3_SECRET: "canary-secret-2" }
    const { blob: config } = resolveBlobViteConfig({ driver: "s3", bucket: "assets", credentials: { accessKeyId: env.S3_KEY, secretAccessKey: env.S3_SECRET } }, { env })
    const entries = blobDeploymentEnv(config, { host: "node" })
    expect(entries).toEqual([
      { names: ["S3_KEY"], required: true, ...blob() },
      { names: ["S3_SECRET"], required: true, ...blob() },
    ])
    expect(JSON.stringify(entries)).not.toContain("canary")
  })

  it("names VITEHUB_SECRET as optional for the signed links of an fs store", () => {
    const { blob: config } = resolveBlobViteConfig({ driver: "fs" }, { env: {} })
    expect(blobDeploymentEnv(config, { host: "node" })).toEqual([{ names: ["VITEHUB_SECRET"], required: false, ...blob() }])
  })
})
