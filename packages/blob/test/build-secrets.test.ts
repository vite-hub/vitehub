import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { hubBlob } from "../src/vite.ts"

import type { AddressInfo } from "node:net"
import type { BlobOptions } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, "../../..")

async function buildNitroApp(root: string, blob: BlobOptions) {
  // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
  const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
  await mkdir(join(root, "server/routes"), { recursive: true })
  await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "dir")
  // The package.json makes this folder the project root, where ViteHub writes `.vitehub`.
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
  await writeFile(join(root, "index.html"), "<main>ok</main>\n")
  await writeFile(join(root, "server/routes/list.ts"), [
    "import { blob } from '@vite-hub/blob'",
    "export default async () => {",
    "  const [error, result] = await blob.list()",
    "  return error ? { error: String(error.cause?.message ?? error.message) } : { blobs: result.blobs.length }",
    "}",
  ].join("\n"))
  const builder = await createBuilder({
    logLevel: "silent",
    // SAFETY: Vite accepts the Nitro-owned `nitro` field that the Nitro plugin reads.
    nitro: { preset: "node-middleware", serverDir: "server" },
    // SAFETY: Nitro's runtime-loaded plugin conforms to Vite's plugin contract.
    plugins: [hubBlob(blob), nitro() as never],
    root,
  } as Parameters<typeof createBuilder>[0])
  await builder.buildApp()
}

async function filesContaining(directory: string, values: string[]) {
  const hits: string[] = []
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const text = await readFile(file, "utf8")
    for (const value of values) if (text.includes(value)) hits.push(`${file.slice(directory.length + 1)}: ${value}`)
  }
  return hits
}

/** Runs the built app in a child process, because Nitro installs process handlers and globals, and returns the route body. */
async function requestBuiltApp(root: string, env: Record<string, string>) {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:http"
    import { middleware } from "./.output/server/index.mjs"
    const server = createServer(middleware)
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/list", { signal: AbortSignal.timeout(10000) })
      console.log(await response.text())
    }
    finally {
      server.closeAllConnections()
      server.close()
    }
  `], { cwd: root, env: { PATH: process.env.PATH, ...env }, timeout: 20_000 })
  return stdout.trim()
}

it("keeps S3 credentials from env out of the server bundle and reads them at runtime", async () => {
  // Test values only. They are not real credentials.
  const accessKeyId = `TESTKEY${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`
  const secretAccessKey = `test-secret-${randomUUID()}`
  const authorizations: string[] = []
  const s3 = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization))
    response.setHeader("content-type", "application/xml")
    response.end("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>assets</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>")
  })
  await new Promise<void>(resolve => s3.listen(0, "127.0.0.1", resolve))
  await mkdir(join(workspaceRoot, ".cache"), { recursive: true })
  const root = await mkdtemp(join(workspaceRoot, ".cache", "blob-build-secrets-"))
  const env = { VITEHUB_TEST_S3_KEY: accessKeyId, VITEHUB_TEST_S3_SECRET: secretAccessKey }
  Object.assign(process.env, env)

  try {
    await buildNitroApp(root, {
      bucket: "assets",
      credentials: { accessKeyId: process.env.VITEHUB_TEST_S3_KEY!, secretAccessKey: process.env.VITEHUB_TEST_S3_SECRET! },
      driver: "s3",
      endpoint: `http://127.0.0.1:${(s3.address() as AddressInfo).port}`,
      forcePathStyle: true,
      region: "us-east-1",
    })
    for (const name of Object.keys(env)) delete process.env[name]

    expect(await filesContaining(join(root, ".output"), [accessKeyId, secretAccessKey])).toEqual([])
    expect(await filesContaining(join(root, ".vitehub"), [accessKeyId, secretAccessKey])).toEqual([])

    expect(await requestBuiltApp(root, env)).toBe(JSON.stringify({ blobs: 0 }))
    expect(authorizations).toEqual([expect.stringContaining(`Credential=${accessKeyId}/`)])

    expect(await requestBuiltApp(root, {})).toContain("Missing runtime environment variable `VITEHUB_TEST_S3_KEY`")
  }
  finally {
    for (const name of Object.keys(env)) delete process.env[name]
    s3.closeAllConnections()
    s3.close()
    await rm(root, { force: true, recursive: true })
  }
}, 120_000)

it("fails the build when a store has a literal credential", async () => {
  await mkdir(join(workspaceRoot, ".cache"), { recursive: true })
  const root = await mkdtemp(join(workspaceRoot, ".cache", "blob-build-literal-"))

  try {
    await expect(buildNitroApp(root, {
      bucket: "assets",
      credentials: { accessKeyId: "TESTLITERALKEY", secretAccessKey: "test-literal-secret" },
      driver: "s3",
    })).rejects.toMatchObject({ code: "BLOB_C0019" })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 60_000)

it("keeps an Azure endpoint with a SAS query out of the server bundle and reads it at runtime", async () => {
  // Test values only. The query has the shape of a SAS token, but it is not a real one.
  const signature = `test-signature-${randomUUID()}`
  const requests: string[] = []
  const azure = createServer((request, response) => {
    requests.push(String(request.url))
    response.setHeader("content-type", "application/xml")
    response.end("<?xml version=\"1.0\" encoding=\"utf-8\"?><EnumerationResults ContainerName=\"assets\"><Blobs /><NextMarker /></EnumerationResults>")
  })
  await new Promise<void>(resolve => azure.listen(0, "127.0.0.1", resolve))
  await mkdir(join(workspaceRoot, ".cache"), { recursive: true })
  const root = await mkdtemp(join(workspaceRoot, ".cache", "blob-build-azure-"))
  const env = { VITEHUB_TEST_AZURE_ENDPOINT: `http://127.0.0.1:${(azure.address() as AddressInfo).port}/acct?sv=2024-01-01&sig=${signature}` }
  Object.assign(process.env, env)

  try {
    await buildNitroApp(root, { accountName: "acct", container: "assets", driver: "azure", endpoint: process.env.VITEHUB_TEST_AZURE_ENDPOINT! })
    for (const name of Object.keys(env)) delete process.env[name]

    expect(await filesContaining(join(root, ".output"), [signature])).toEqual([])
    expect(await filesContaining(join(root, ".vitehub"), [signature])).toEqual([])

    await requestBuiltApp(root, env)
    expect(requests).toEqual([expect.stringContaining(`sig=${signature}`)])
  }
  finally {
    for (const name of Object.keys(env)) delete process.env[name]
    azure.closeAllConnections()
    azure.close()
    await rm(root, { force: true, recursive: true })
  }
}, 120_000)
