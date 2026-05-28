import { existsSync } from "node:fs"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/build/esbuild.ts", () => ({
  bundleEsmEntry: vi.fn(async () => undefined),
}))

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-internal-deployment-output-"))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("provider deployment outputs", () => {
  it("removes stale default output roots for omitted providers", async () => {
    const rootDir = await createTempProject()
    const {
      createDefaultCloudflareOutputRoot,
      createDefaultVercelOutputRoot,
      writeProviderDeploymentOutputs,
    } = await import("../src/build/deployment-output.ts")
    const cloudflareDir = createDefaultCloudflareOutputRoot(rootDir)
    const vercelDir = createDefaultVercelOutputRoot(rootDir)
    await mkdir(cloudflareDir, { recursive: true })
    await mkdir(vercelDir, { recursive: true })
    await writeFile(join(cloudflareDir, "wrangler.json"), "{}")
    await writeFile(join(vercelDir, "config.json"), "{}")

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      rootDir,
      vercel: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
      },
    })

    expect(existsSync(cloudflareDir)).toBe(false)
    expect(existsSync(vercelDir)).toBe(true)

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist/client",
      cloudflare: {
        bundleEntry: join(rootDir, "entry.mjs"),
        bundleOptions: {},
        wranglerConfig: {},
      },
      rootDir,
    })

    expect(existsSync(cloudflareDir)).toBe(true)
    expect(existsSync(vercelDir)).toBe(false)
  })
})
