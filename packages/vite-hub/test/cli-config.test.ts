import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { loadViteHubCliConfig } from "../src/internal/cli-config.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(config: "nuxt" | "vite") {
  const root = await mkdtemp(join(tmpdir(), "vitehub-cli-config-"))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${config}.config.ts`), "export default {}\n", "utf8")
  return root
}

describe("ViteHub CLI config loading", () => {
  it("loads Nuxt Vite options when Nuxt is the project config owner", async () => {
    const root = await createProject("nuxt")
    const close = vi.fn()
    const loadNuxt = vi.fn(async () => ({
      close,
      options: {
        rootDir: root,
        vite: { plugins: [{ name: "nuxt-vitehub" }] },
      },
    }))
    const resolveViteConfig = vi.fn(async config => ({
      plugins: config.plugins || [],
      root: String(config.root),
    }))

    await expect(loadViteHubCliConfig(root, { loadNuxt, resolveViteConfig })).resolves.toEqual({
      plugins: [{ name: "nuxt-vitehub" }],
      root,
    })
    expect(resolveViteConfig).toHaveBeenCalledWith(expect.objectContaining({
      configFile: false,
      root,
    }), "serve", "development")
    expect(close).toHaveBeenCalledOnce()
  })

  it("keeps explicit Vite config ownership", async () => {
    const root = await createProject("vite")
    const loadNuxt = vi.fn()
    const resolveViteConfig = vi.fn(async config => ({ plugins: [], root: String(config.root) }))

    await loadViteHubCliConfig(root, { loadNuxt, resolveViteConfig })

    expect(loadNuxt).not.toHaveBeenCalled()
    expect(resolveViteConfig).toHaveBeenCalledWith({ root }, "serve", "development")
  })
})
