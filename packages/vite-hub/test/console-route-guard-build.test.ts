import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "vite-hub"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function build(files: Record<string, string>, base = "/"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-route-guard-"))
  roots.push(root)
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  const all = { "package.json": JSON.stringify({ private: true, type: "module" }), "index.html": "<main>ok</main>\n", ...files }
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({
    base,
    logLevel: "silent",
    plugins: [vitehub({ host: "node", publicUrl: "http://app.example.com", console: true }), nitro() as never],
    root,
  })
  await builder.buildApp()
}

const appRoute = 'export default () => ({ owner: "app" })\n'

describe("App route files on the Console route", () => {
  it.each(["rpc.post.ts", "rpc.get.ts", "rpc.ts"])("refuses server/routes/_vitehub/%s at build time", { timeout: 240_000 }, async (file) => {
    await expect(build({ [`server/routes/_vitehub/${file}`]: appRoute })).rejects.toThrow('Cannot mount the ViteHub Console handler at "/_vitehub/rpc" because the app route')
  })

  it("builds an app route at /_vitehub/rpc when the Console mounts below the Vite base", { timeout: 240_000 }, async () => {
    await expect(build({ "server/routes/_vitehub/rpc.post.ts": appRoute }, "/portal/")).resolves.toBeUndefined()
    await expect(build({ "server/routes/portal/_vitehub/rpc.post.ts": appRoute }, "/portal/")).rejects.toThrow('Cannot mount the ViteHub Console handler at "/portal/_vitehub/rpc"')
  })
})
