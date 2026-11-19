import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { blob } from "@vite-hub/blob"
import { setBlobRuntimeConfig } from "@vite-hub/blob/runtime/state"

import { afterEach, describe, expect, it, vi } from "vitest"

import { healthVitePlugin, renderHealthHandler, type HealthTargets } from "../src/health-vite.ts"
import { readViteHubVersion } from "../src/version.ts"

type Handler = { fetch(): Promise<Response> }
type Modules = Record<string, Record<string, unknown>>

/** Evaluates the generated handler, with stubs for the modules that it imports. */
function handler(targets: Partial<HealthTargets>, modules: Modules = {}): Handler {
  const source = renderHealthHandler({ commit: "abc123", vitehub: "0.0.9", database: false, kv: [], blob: [], ...targets })
    .replace(/\bimport\(/g, "load(")
    .replace("export default", "return")
  const load = async (specifier: string) => modules[specifier]
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("load", source)(load) as Handler
}

const roots: string[] = []

afterEach(async () => {
  setBlobRuntimeConfig(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("health route", () => {
  it("answers ok, the commit, and the ViteHub version, and is never cached", async () => {
    const response = await handler({}).fetch()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ ok: true, commit: "abc123", vitehub: "0.0.9" })
  })

  it("answers the app version when its package.json has one", async () => {
    const source = renderHealthHandler({ version: "1.4.0", commit: null, vitehub: "0.0.9", database: false, kv: [], blob: [] }).replace("export default", "return")
    // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
    const response = await (new Function(source)() as Handler).fetch()
    expect(await response.json()).toEqual({ ok: true, version: "1.4.0", commit: null, vitehub: "0.0.9" })
  })

  it("checks each Database, KV store, and Blob store, and answers 503 without error text when one fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("connect ECONNREFUSED redis://user:secret@cache:6379")
    const reads: string[] = []
    const store = (kind: string, failing?: string) => (name: string) => {
      const read = async (key: string) => {
        reads.push(`${kind}:${name}:${key}`)
        return name === failing ? [failure, undefined] : [undefined, null]
      }
      return { has: read, list: async (options: unknown) => {
        reads.push(`${kind}:${name}:list:${JSON.stringify(options)}`)
        return name === failing ? [failure, undefined] : [undefined, { blobs: [], hasMore: false }]
      } }
    }
    const modules = (failingKV?: string): Modules => ({
      "@vite-hub/database/runtime/registry": { pingDatabases: async () => ({ default: true }) },
      "vite-hub/kv": { kv: { store: store("kv", failingKV) } },
      "vite-hub/blob": { blob: { store: store("blob") } },
    })
    const targets = { database: true, kv: ["default", "sessions"], blob: ["default"] }

    const healthy = await handler(targets, modules()).fetch()
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual({
      ok: true,
      commit: "abc123",
      vitehub: "0.0.9",
      checks: { database: { default: true }, kv: { default: true, sessions: true }, blob: { default: true } },
    })
    expect(reads).toEqual(["kv:default:vitehub-health-check", "kv:sessions:vitehub-health-check", "blob:default:list:{\"limit\":1}"])

    const failing = await handler(targets, modules("sessions")).fetch()
    expect(failing.status).toBe(503)
    const body = await failing.text()
    expect(JSON.parse(body)).toMatchObject({ ok: false, checks: { kv: { default: true, sessions: false } } })
    expect(body).not.toContain("secret")
    expect(log).toHaveBeenCalledWith("[vitehub] KV store \"sessions\" did not answer the health check.", failure)
  })

  it("counts a store that does not answer within 2 seconds as failed", async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const modules: Modules = { "vite-hub/blob": { blob: { store: () => ({ list: () => new Promise(() => {}) }) } } }

    const pending = handler({ blob: ["uploads"] }, modules).fetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const response = await pending

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, commit: "abc123", vitehub: "0.0.9", checks: { blob: { uploads: false } } })
    expect(log).toHaveBeenCalledWith("[vitehub] Blob store \"uploads\" did not answer the health check.", new Error("No answer within 2000 ms."))
  })

  it("registers the route with the app version, the commit of the build, and the installed ViteHub version", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "def456")
    const root = await mkdtemp(join(tmpdir(), "vitehub-health-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ferry-times", version: "1.4.0" }))
    const config: Record<string, unknown> = { root }
    const targets = { database: false, kv: [], blob: [] }

    await (healthVitePlugin({}, targets).config as (config: object) => Promise<void>)(config)
    const custom: Record<string, unknown> = { root }
    await (healthVitePlugin({ route: "/api/health" }, targets).config as (config: object) => Promise<void>)(custom)

    const file = join(root, ".vitehub/nitro/health.mjs")
    expect(config.nitro).toMatchObject({ handlers: [{ handler: file, route: "/_vitehub/health" }] })
    expect(custom.nitro).toMatchObject({ handlers: [{ handler: file, route: "/api/health" }] })
    const source = await readFile(file, "utf8")
    expect(source).toContain(`const version = "1.4.0"`)
    expect(source).toContain(`const commit = "def456"`)
    expect(source).toContain(`const vitehub = ${JSON.stringify(readViteHubVersion())}`)
  })
})

type BlobStore = Exclude<Parameters<typeof setBlobRuntimeConfig>[0], false | undefined>["store"]

/** The Blob check of the generated handler, run against the real Blob runtime with `store` as the `uploads` store. */
async function checkUploads(store: BlobStore): Promise<{ status: number, uploads: boolean }> {
  setBlobRuntimeConfig({ store, stores: { uploads: store } })
  const response = await handler({ blob: ["uploads"] }, { "vite-hub/blob": { blob } }).fetch()
  const body = await response.json() as { checks: { blob: { uploads: boolean } } }
  return { status: response.status, uploads: body.checks.blob.uploads }
}

/** A local S3 endpoint with one empty bucket, `uploads`. Other buckets do not exist, as on AWS. */
async function fakeS3(): Promise<{ endpoint: string, close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://s3.test")
    const [bucket, key = ""] = url.pathname.slice(1).split(/\/(.*)/)
    if (bucket !== "uploads") {
      response.writeHead(404, { "content-type": "application/xml" })
      // A HEAD answer has no body, so S3 clients see a missing bucket as a missing object.
      response.end(request.method === "HEAD" ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><BucketName>${bucket}</BucketName></Error>`)
      return
    }
    if (request.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      response.writeHead(200, { "content-type": "application/xml" })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>uploads</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`)
      return
    }
    response.writeHead(404, { "content-type": "application/xml" })
    response.end(request.method === "HEAD" ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The fake S3 server has no port.")
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

describe("health route Blob check", () => {
  it("passes an empty filesystem store and fails one whose folder is a file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const root = await mkdtemp(join(tmpdir(), "vitehub-health-blob-"))
    roots.push(root)

    expect(await checkUploads({ driver: "fs", base: join(root, "blob") })).toEqual({ status: 200, uploads: true })

    await writeFile(join(root, "blob"), "not a folder")
    expect(await checkUploads({ driver: "fs", base: join(root, "blob") })).toEqual({ status: 503, uploads: false })
  })

  it("passes an empty S3 bucket and fails a bucket that does not exist", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const s3 = await fakeS3()
    try {
      const store = (bucket: string): BlobStore => ({
        driver: "s3",
        bucket,
        credentials: { accessKeyId: "AKIAHEALTHCHECK", secretAccessKey: "health-check-secret" },
        endpoint: s3.endpoint,
        forcePathStyle: true,
        region: "us-east-1",
      })
      // Loads the AWS SDK before the timed check: under Vitest the first import alone can take more than 2 seconds.
      setBlobRuntimeConfig({ store: store("uploads") })
      await blob.head("warm-up")

      expect(await checkUploads(store("uploads"))).toEqual({ status: 200, uploads: true })
      expect(await checkUploads(store("uploads-typo"))).toEqual({ status: 503, uploads: false })
    }
    finally {
      await s3.close()
    }
  })
})
