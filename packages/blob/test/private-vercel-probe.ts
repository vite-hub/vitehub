import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { Server } from "node:http"

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  return address
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()),
  )
}

/** Lists private Vercel Blob objects through the bundled Nitro Blob runtime against a local Blob API. */
export async function probePrivateVercelBlobRuntime(appDir: string) {
  const blobApi = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ blobs: [], hasMore: false }))
  })
  const blobApiAddress = await listen(blobApi)
  const originalBlobApiUrl = process.env.VERCEL_BLOB_API_URL
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${blobApiAddress.port}`

  try {
    const runtimeEntry = join(appDir, "dist/vercel/server.mjs")
    const { blob } = await import(`${pathToFileURL(runtimeEntry).href}?t=${Date.now()}`) as {
      blob: { list: () => Promise<[unknown, { blobs: unknown[] } | undefined]> }
    }
    const [error, result] = await blob.list()
    if (error) throw error
    assert.deepEqual(result?.blobs, [])
  }
  finally {
    if (originalBlobApiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL
    else process.env.VERCEL_BLOB_API_URL = originalBlobApiUrl
    await close(blobApi)
  }
}
