import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { hubI18n } from "../src/vite.ts"

describe("hubI18n", () => {
  it("installs the Nitro 3 request context plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-vite-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      const config = { root, nitro: { plugins: ["/user-plugin.mjs"], experimental: { openAPI: true } } }
      const hook = plugin.config as { handler: (config: object) => Promise<unknown> }
      await hook.handler(config)

      const generatedPlugin = join(root, ".vitehub/nitro/i18n/plugin.mjs")
      expect(config.nitro).toMatchObject({
        plugins: [generatedPlugin, "/user-plugin.mjs"],
        experimental: { asyncContext: true, openAPI: true },
      })
      const source = await readFile(generatedPlugin, "utf8")
      expect(source).toContain('import { definePlugin } from "nitro"')
      expect(source).toContain('import { useRequest } from "nitro/context"')
      expect(source).toContain("return useRequest()")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("compiles server macros in Nitro's own bundler, which has no Vite environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-nitro-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      const config = plugin.config as { handler: (config: object, env: { command: string }) => Promise<unknown> }
      await config.handler({ root, nitro: {} }, { command: "build" })
      const route = join(root, "server/api/pay.ts")
      const code = "import { t } from '@vite-hub/i18n'\nexport default () => t`Payment received`\n"
      await mkdir(join(root, "server/api"), { recursive: true })
      await writeFile(route, code)
      const transform = plugin.transform as { handler: (this: object, code: string, id: string, options: { ssr: boolean }) => Promise<{ code: string } | undefined> }
      const result = await transform.handler.call({}, code, route, { ssr: true })
      expect(result?.code).toContain('"@vite-hub/i18n/runtime"')
      expect(result?.code).toContain('message: "Payment received"')
      expect(result?.code).not.toContain("t`Payment received`")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("hubI18n i18n.workspace", () => {
  const workspacePlugin = (names: string[]) => ({ name: "@vite-hub/workspace/vite", api: { getWorkspaces: () => names.map(name => ({ name })) } })
  const resolve = async (workspace: string, plugins: object[]) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-workspace-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root, workspace })
      const hook = plugin.config as { handler: (config: object, env: { command: string }) => Promise<unknown> }
      await hook.handler({ root, nitro: {} }, { command: "build" })
      const configResolved = plugin.configResolved as (config: object) => void
      configResolved({ isProduction: true, plugins: [...plugins, plugin] })
      const buildStart = plugin.buildStart as () => void
      buildStart()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it("accepts a Workspace that the app defines", async () => {
    await expect(resolve("translations", [workspacePlugin(["docs", "translations"])])).resolves.toBeUndefined()
  })

  it("fails the build on a Workspace name that the app does not define", async () => {
    await expect(resolve("translation", [workspacePlugin(["docs", "translations"])])).rejects.toMatchObject({
      code: "I18N_UNKNOWN_WORKSPACE",
      why: "`i18n.workspace` is \"translation\", and the app defines only these Workspaces: \"docs\", \"translations\".",
    })
    await expect(resolve("translations", [workspacePlugin([])])).rejects.toMatchObject({
      code: "I18N_UNKNOWN_WORKSPACE",
      why: "`i18n.workspace` is \"translations\", and the app defines no Workspace.",
    })
  })

  it("fails the build when Workspace is not enabled", async () => {
    await expect(resolve("translations", [])).rejects.toMatchObject({
      code: "I18N_UNKNOWN_WORKSPACE",
      why: "`i18n.workspace` is \"translations\", and Workspace is not enabled.",
    })
  })
})
