import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build, copyPublicAssets, createNitro, prepare, prerender } from "nitropack/core"
import { resolveConfig } from "vite"
import { vitehub } from "vite-hub"
import { expect, it } from "vitest"

it("preserves Nitro Netlify output when emitting the ViteHub deployment manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-netlify-output-"))
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  try {
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "server/routes/index.ts"), "export default defineEventHandler(() => 'ok')\n", "utf8")
    const config = await resolveConfig({
      root,
      plugins: [vitehub({
        preset: "netlify",
        agent: false,
        blob: false,
        database: false,
        devtools: false,
        env: false,
        queue: false,
        rateLimit: false,
        workflow: false,
        workspace: false,
      })],
    }, "build")
    const nitroConfig = (config as typeof config & { nitro?: Parameters<typeof createNitro>[0] }).nitro
    expect(nitroConfig).toBeDefined()

    nitro = await createNitro({ ...nitroConfig, dev: false, rootDir: root })
    await prepare(nitro)
    await copyPublicAssets(nitro)
    await prerender(nitro)
    await build(nitro)

    const netlifyDeploymentPath = join(root, ".netlify/deployment.json")
    const missingNetlifyDeploymentOutputs = [
      ".netlify/functions-internal/server/server.mjs",
      "dist/_redirects",
      ".netlify/deployment.json",
    ].filter(path => !existsSync(join(root, path)))
    expect(missingNetlifyDeploymentOutputs, "Netlify must preserve Nitro output and emit the ViteHub deployment manifest").toEqual([])
    await expect(readFile(netlifyDeploymentPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      host: "netlify",
      output: {
        directory: ".netlify",
        entry: "functions-internal/server/server.mjs",
      },
      preset: "netlify",
      runtime: "node",
    })
  } finally {
    try {
      await nitro?.close()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
})
