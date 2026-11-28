import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, it } from "vitest"

import { generatedQueueNitroMiddleware, generatedQueueNitroPlugin, generatedQueueNitroVercelConsumerDir, writeQueueNitroIntegration } from "../src/internal/vite-build.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function modifiedTimes(files: string[]): Promise<number[]> {
  return Promise.all(files.map(async file => (await stat(file)).mtimeMs))
}

it("keeps generated Queue files untouched when their contents do not change", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-queue-generated-writes-"))
  roots.push(root)
  const handler = join(root, "welcome.queue.ts")
  await writeFile(handler, "export default { handler: async () => undefined }\n")
  const definitions = [{ handler, name: "welcome" }]
  await writeQueueNitroIntegration(root, { driver: "vercel" }, "vercel", true, definitions)
  const consumerDir = resolve(root, generatedQueueNitroVercelConsumerDir)
  const files = [
    resolve(root, ".vitehub/queue.d.ts"),
    resolve(root, ".vitehub/queue/registry.mjs"),
    resolve(root, generatedQueueNitroPlugin),
    resolve(root, generatedQueueNitroMiddleware),
    ...(await readdir(consumerDir)).map(name => resolve(consumerDir, name)),
  ]
  const past = new Date(Date.now() - 60_000)
  await Promise.all(files.map(file => utimes(file, past, past)))
  const before = await modifiedTimes(files)
  await writeFile(resolve(consumerDir, "removed.func.mjs"), "export default {}\n")

  await writeQueueNitroIntegration(root, { driver: "vercel" }, "vercel", true, definitions)

  expect(files).toHaveLength(5)
  expect(await modifiedTimes(files)).toEqual(before)
  expect(await readdir(consumerDir)).not.toContain("removed.func.mjs")
})
