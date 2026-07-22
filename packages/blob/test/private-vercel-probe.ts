import { strict as assert } from "node:assert"
import { createServer, get } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { IncomingMessage, Server, ServerResponse } from "node:http"

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

export async function probePrivateVercelFunction(appDir: string) {
  const blobApi = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ blobs: [], hasMore: false }))
  })
  const blobApiAddress = await listen(blobApi)
  const originalBlobApiUrl = process.env.VERCEL_BLOB_API_URL
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${blobApiAddress.port}`

  const serverEntry = join(appDir, ".vercel/output/functions/__server.func/index.mjs")
  const generated = await import(`${pathToFileURL(serverEntry).href}?t=${Date.now()}`) as {
    default: (request: IncomingMessage, response: ServerResponse) => unknown
  }
  const server = createServer((request, response) => {
    Promise.resolve(generated.default(request, response)).catch((error) => {
      response.statusCode = 500
      response.end(error instanceof Error ? error.stack : String(error))
    })
  })
  const address = await listen(server)

  try {
    const result = await new Promise<{ body: string, status?: number }>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/api/stats`, (response) => {
        const chunks: Buffer[] = []
        response.on("data", chunk => chunks.push(chunk))
        response.on("end", () => resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode,
        }))
      }).once("error", reject)
    })

    assert.equal(result.status, 200, result.body)
    assert.deepEqual(JSON.parse(result.body).blobs, [])
  }
  finally {
    if (originalBlobApiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL
    else process.env.VERCEL_BLOB_API_URL = originalBlobApiUrl
    await Promise.all([close(server), close(blobApi)])
  }
}
