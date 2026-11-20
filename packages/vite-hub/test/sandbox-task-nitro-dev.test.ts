import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { hubSandboxTask } from "@vite-hub/sandbox/task/vite"
import { nitro } from "nitro/vite"
import { createServer } from "vite"
import { expect, it } from "vitest"

it.skipIf(process.platform === "win32")("rejects local Sandbox Tasks during Nitro's Miniflare dev setup", async () => {
  const root = await mkdtemp(join(import.meta.dirname, ".vitest-tmp-sandbox-nitro-"))
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/hello.sandbox-task.ts"), `
      import { defineSandboxTask } from "@vite-hub/sandbox/task"
      export default defineSandboxTask({ handler: async () => "hello" })
    `)
    const start = async () => {
      const server = await createServer({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [nitro({ preset: "cloudflare_module", devServer: { runner: "miniflare" } }), hubSandboxTask({ driver: "cloudflare" })],
        server: { port: 0 },
      })
      try {
        await server.listen()
      }
      finally {
        await server.close()
      }
    }
    await expect(start()).rejects.toMatchObject({
      code: "SANDBOX_TASK_LOCAL_NITRO_RUNNER",
      fix: expect.stringContaining("node-worker"),
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
