import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { expect, it, vi } from "vitest"

import { vitehub } from "../src/index.ts"

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  const manifest = resolve(import.meta.dirname, "../package.json")
  const readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => file === manifest
    ? JSON.stringify({ version: "0.3.1", peerDependencies: { "drizzle-orm": "^99.0.0" } })
    : Reflect.apply(fs.readFileSync, fs, [file, ...args])) as typeof fs.readFileSync
  return { ...fs, readFileSync }
})

async function build(loadAdapter: boolean): Promise<void> {
  const packages = resolve(import.meta.dirname, "../..")
  const root = await mkdtemp(join(tmpdir(), "vitehub-drizzle-build-check-"))
  try {
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    await symlink(join(packages, "agent"), join(root, "node_modules/@vite-hub/agent"), "dir")
    await symlink(join(packages, "vite-hub"), join(root, "node_modules/vite-hub"), "dir")
    await symlink(join(packages, "agent/node_modules/drizzle-orm"), join(root, "node_modules/drizzle-orm"), "dir")
    await symlink(join(packages, "vite-hub/node_modules/h3"), join(root, "node_modules/h3"), "dir")
    await mkdir(join(root, "server/routes"), { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await writeFile(join(root, "server/routes/index.ts"), loadAdapter ? `
      import { getAgentInvocationsDatabase } from 'vite-hub/agent/invocations/drizzle'
      export default async () => (await getAgentInvocationsDatabase())?.driver
    ` : `
      import { defineAgent } from 'vite-hub/agent'
      const agent = defineAgent({ runtime: false, driver: { run: () => ({ text: 'Hello' }) } })
      export default () => typeof agent.driver.run
    `)
    const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
    const builder = await createBuilder({
      configFile: false,
      logLevel: "silent",
      root,
      plugins: [vitehub({ agent: loadAdapter ? true : { invocations: false }, console: false, host: "node", workflow: false }), nitro() as never],
    })
    await builder.buildApp()
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("builds an Agent with an unrelated out-of-range Drizzle peer", async () => {
  await expect(build(false)).resolves.toBeUndefined()
}, 120_000)

it("reports the supported Drizzle range when the build reaches the journal query adapter", async () => {
  const printed = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await expect(build(true)).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({
        plugin: "vite-hub/drizzle-build-check",
        pluginCode: "VITE_HUB_PEER_VERSION_UNSUPPORTED",
      })]),
    })
    expect(printed).toHaveBeenCalledWith(expect.stringContaining("pnpm add 'drizzle-orm@^99.0.0'"))
  }
  finally {
    printed.mockRestore()
  }
}, 120_000)
