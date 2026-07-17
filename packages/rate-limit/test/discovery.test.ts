import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { discoverRateLimitDefinitions } from "../src/discovery.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it("discovers suffix and server Rate Limit Definitions through the shared catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-discovery-"))
  roots.push(root)
  await mkdir(join(root, "src", "limits"), { recursive: true })
  await mkdir(join(root, "server", "rate-limits", "api"), { recursive: true })
  await writeFile(join(root, "src", "limits", "upload.rate-limit.ts"), "export default {}\n")
  await writeFile(join(root, "server", "rate-limits", "api", "search.ts"), "export default {}\n")

  expect(discoverRateLimitDefinitions({ rootDir: root })).toEqual([
    expect.objectContaining({ name: "api/search", source: "server-rate-limits" }),
    expect.objectContaining({ name: "limits/upload", source: "vite-suffix" }),
  ])
})
