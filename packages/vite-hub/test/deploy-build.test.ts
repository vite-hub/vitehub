import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { indexNowKey, resolveDeployManifest } from "../src/deploy-options.ts"
import { vitehub } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

const cwd = process.cwd()

afterEach(() => {
  process.chdir(cwd)
})

describe("deploy options", () => {
  it("checks the health route first, once, and keeps the order of deploy.check", () => {
    expect(resolveDeployManifest({ deploy: { check: ["/", "/_vitehub/health"] }, health: true, publicUrl: undefined })).toEqual({ check: ["/_vitehub/health", "/"] })
    expect(resolveDeployManifest({ deploy: { check: "/" }, health: { route: "/api/health" }, publicUrl: undefined })).toEqual({ check: ["/api/health", "/"] })
    expect(resolveDeployManifest({ deploy: undefined, health: undefined, publicUrl: "https://shop.example.com" })).toBeUndefined()
  })

  it("gives one IndexNow key to each site that IndexNow accepts", () => {
    const key = indexNowKey("https://shop.example.com")
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    expect(indexNowKey("https://shop.example.com")).toBe(key)
    expect(indexNowKey("https://blog.example.com")).not.toBe(key)
    expect(resolveDeployManifest({ deploy: { indexNow: true }, health: false, publicUrl: "https://shop.example.com" })).toEqual({ check: [], indexNow: { key, url: "https://shop.example.com" } })
  })

  it("refuses a check that is not a path and IndexNow without publicUrl", () => {
    for (const path of ["https://shop.example.com/", "//cdn.example.com/x", "api/health", "/a b"]) {
      expect(() => resolveDeployManifest({ deploy: { check: [path] }, health: false, publicUrl: undefined }), path).toThrow(expect.objectContaining({ code: "VITE_HUB_DEPLOY_CHECK_INVALID" }))
    }
    expect(() => resolveDeployManifest({ deploy: { indexNow: true }, health: false, publicUrl: undefined })).toThrow(expect.objectContaining({ code: "VITE_HUB_DEPLOY_INDEX_NOW_PUBLIC_URL_MISSING" }))
  })
})

describe("deploy options in a built Nitro 3 app", () => {
  it("writes the checks and the IndexNow key to deployment.json and serves the key file", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "deploy-build", private: true, type: "module" }),
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
    })
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const app = [vitehub({ deploy: { check: ["/"], indexNow: true }, health: true, host: "node", publicUrl: "https://shop.example.com/" }), nitro()]
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: app, root } as never)
    await builder.buildApp()

    const key = indexNowKey("https://shop.example.com")
    const manifest = JSON.parse(await readFile(join(root, ".output/deployment.json"), "utf8")) as Record<string, unknown>
    expect(manifest.deploy).toEqual({ check: ["/_vitehub/health", "/"], indexNow: { key, url: "https://shop.example.com" } })

    process.chdir(root)
    const server = await startBuiltServer(root, {})
    try {
      const response = await server.fetch(`/${key}.txt`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(key)
    }
    finally {
      server.close()
    }
  }, 120_000)
})
