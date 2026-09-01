import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  hasNitroConfigContext,
  resolveNitroVercelFunctionName,
  resolveViteHubGeneratedRoot,
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
} from "../src/build/vite.ts"

describe("Vite provider builds", () => {
  it("honors a project marker at the system temporary root", async () => {
    const previousTemporaryDirectories = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "vitehub-project-root-boundary-"))
    const projectRoot = join(temporaryRoot, "fixture")
    try {
      await mkdir(projectRoot)
      await writeFile(join(temporaryRoot, "package.json"), '{"private":true}\n')
      process.env.TEMP = temporaryRoot
      process.env.TMP = temporaryRoot
      process.env.TMPDIR = temporaryRoot

      expect(resolveViteHubProjectRoot(projectRoot)).toBe(temporaryRoot)
      expect(resolveViteHubProjectRoot(projectRoot, { projectRoot: temporaryRoot })).toBe(temporaryRoot)
    }
    finally {
      for (const [name, value] of Object.entries(previousTemporaryDirectories)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(temporaryRoot, { force: true, recursive: true })
    }
  })

  it("prefers a marked parent for app roots", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-app-project-root-"))
    const appRoot = join(projectRoot, "app")
    try {
      await mkdir(appRoot)
      await Promise.all([
        writeFile(join(projectRoot, "package.json"), '{"private":true}\n'),
        writeFile(join(appRoot, "package.json"), '{"private":true}\n'),
      ])

      expect(resolveViteHubProjectRoot(appRoot)).toBe(projectRoot)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("resolves the shared generated-artifact root", () => {
    expect(resolveViteHubGeneratedRoot({ root: "/app" })).toBe("/app/.vitehub")
    expect(resolveViteHubGeneratedRoot({
      [VITEHUB_GENERATED_ROOT]: "/app/.nuxt/vitehub",
      root: "/app",
    })).toBe("/app/.nuxt/vitehub")
  })

  it("distinguishes the Nitro host plugin from ViteHub bridge plugins", () => {
    expect(hasNitroConfigContext({ plugins: [{ name: "nitro:main" }] })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [[false, [{ name: "nitro:main" }]]] })).toBe(true)
    expect(hasNitroConfigContext({ [VITEHUB_NITRO_CONFIG_CONTEXT]: true })).toBe(true)
    expect(hasNitroConfigContext({ plugins: [{ name: "@vite-hub/blob/vite" }, { name: "@vite-hub/queue/vite" }] })).toBe(false)
    expect(hasNitroConfigContext({ plugins: [[{ name: "@vite-hub/blob/vite" }]] })).toBe(false)
  })

  it("isolates provider functions when Nitro owns the Vercel output", () => {
    const plugins = [{ name: "vitehub" }, { name: "nitro:main" }]

    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel" } }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "queue", { VERCEL: "1" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({ plugins }, "workflow", { VITEHUB_HOSTING: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel" }, plugins: [{ name: "vitehub" }] }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ nitro: { preset: "vercel-edge" } }, "database", {})).toBe("__database.func")
    expect(resolveNitroVercelFunctionName({}, "workflow", { NITRO_PRESET: "vercel" })).toBe("__workflow.func")
    expect(resolveNitroVercelFunctionName({}, "queue", { SERVER_PRESET: "vercel-edge" })).toBe("__queue.func")
    expect(resolveNitroVercelFunctionName({
      environments: { client: { build: { outDir: ".vercel/output/static" } } },
      plugins,
    }, "blob", {})).toBe("__blob.func")
    expect(resolveNitroVercelFunctionName({ plugins: [{ name: "vitehub" }] }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({}, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", {})).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "node-server" } }, "blob", { VERCEL: "1" })).toBeUndefined()
    expect(resolveNitroVercelFunctionName({ plugins, nitro: { preset: "cloudflare" } }, "blob", { VITEHUB_HOSTING: "vercel" })).toBeUndefined()
  })
})
