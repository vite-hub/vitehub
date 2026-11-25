import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_GENERATED_ROOT } from "@vite-hub/internal/build/vite"
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
      const code = "import { getLocale, t as translate, plural } from 'vite-hub/i18n'\nexport default () => ({ locale: getLocale(), message: translate`Payment received`, items: plural(2, { one: '# item', other: '# items' }) })\n"
      await mkdir(join(root, "server/api"), { recursive: true })
      await writeFile(route, code)
      const transform = plugin.transform as { handler: (this: object, code: string, id: string, options: { ssr: boolean }) => Promise<{ code: string } | undefined> }
      const result = await transform.handler.call({}, code, route, { ssr: true })
      expect(result?.code).toContain('"@vite-hub/i18n/runtime"')
      expect(result?.code).toContain('message: "Payment received"')
      expect(result?.code).toContain("# items")
      expect(result?.code).not.toContain("translate`Payment received`")
      expect(result?.code).not.toContain("plural(2")

      const runtimeOnly = `
        import { getLocale } from 'vite-hub/i18n'
        function decorate(target: typeof Route) { return target }
        @decorate
        class Route {
          t() { return getLocale() }
        }
        export default () => new Route().t()
      `
      await expect(transform.handler.call({}, runtimeOnly, route, { ssr: true })).resolves.toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("gives Nitro's own bundler the messages of the browser build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-nitro-messages-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      const config = plugin.config as { handler: (config: object, env: { command: string }) => Promise<unknown> }
      await config.handler({ root, nitro: {} }, { command: "build" })
      const configResolved = plugin.configResolved as (config: object) => void
      configResolved({ isProduction: true, plugins: [plugin] })
      const page = join(root, "app/pages/checkout.ts")
      const code = "import { t } from 'vite-hub/i18n'\nexport const title = t`Checkout`\n"
      await mkdir(join(root, "app/pages"), { recursive: true })
      await writeFile(page, code)
      const client = { environment: { name: "client", config: { consumer: "client", command: "build" } }, getModuleIds: () => [page] }
      const transform = plugin.transform as { handler: (this: object, code: string, id: string) => Promise<unknown> }
      await transform.handler.call(client, code, page)
      const renderStart = plugin.renderStart as (this: object) => void
      renderStart.call(client)
      const resolveId = plugin.resolveId as (id: string) => string | undefined
      const load = plugin.load as (this: object, id: string) => Promise<string | undefined>
      const module = await load.call({}, resolveId("virtual:vite-hub/i18n/build-messages")!)
      expect(module).not.toContain("__VITEHUB_I18N_")
      const clientIds = JSON.parse(/export const clientIds = (.*)\n/.exec(module!)![1]!) as string[]
      const sources = JSON.parse(/export const sources = (.*)\n/.exec(module!)![1]!) as Record<string, { message: string }>
      expect(clientIds).toHaveLength(1)
      expect(sources[clientIds[0]!]).toMatchObject({ message: "Checkout" })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("hubI18n i18n.workspace", () => {
  it.each([
    { clientIds: [1], sources: {} },
    { clientIds: [], sources: { invalid: { message: "Checkout", hash: "abc", origins: "app.ts:1" } } },
  ])("rejects a malformed cached Vue message inventory: %j", async (inventory) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-workspace-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root, workspace: "translations" })
      const config = plugin.config as { handler: (config: object, env: { command: string }) => Promise<unknown> }
      await config.handler({ root, nitro: {}, [VITEHUB_GENERATED_ROOT]: root }, { command: "build" })
      await mkdir(join(root, "i18n"), { recursive: true })
      await writeFile(join(root, "i18n/vue-messages.json"), JSON.stringify(inventory))
      const renderChunk = plugin.renderChunk as (this: object, code: string) => Promise<unknown>
      await expect(renderChunk.call({ getModuleIds: () => [] }, 'export const clientIds = "__VITEHUB_I18N_CLIENT_IDS__"'))
        .rejects.toThrow("Invalid Vue i18n message inventory")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
