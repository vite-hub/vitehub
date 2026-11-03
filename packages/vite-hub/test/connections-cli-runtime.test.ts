import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const bin = new URL("../dist/bin.js", import.meta.url).pathname
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const task of cleanup.splice(0)) await task()
})

// Loading the project runs every ViteHub plugin, and the server files that they write make a running dev server rebuild.
it("runs connections commands against the running app without loading the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-cli-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "vite.config.mjs"), "throw new Error('the project config was loaded')\n")
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ connections: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The test server has no port.")

  const { stdout } = await execFileAsync(process.execPath, [bin, "connections", "list", "--url", `http://127.0.0.1:${address.port}`], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 10_000,
  })

  expect(stdout).toBe("No Connections found.\n")
  expect(requests).toEqual(["POST /_vitehub/connections"])
})
