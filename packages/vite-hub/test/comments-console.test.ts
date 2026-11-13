import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { hubComments } from "@vite-hub/comments/vite"
import { describe, expect, it, vi } from "vitest"

import { describeConsoleContributedSections } from "../src/console/contributions.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"
import { consoleVitePlugin, resolveGeneratedConsolePlugin } from "../src/console/vite.ts"
import { productionConsole } from "./support/console-authorize.ts"

import type { UserConfig } from "vite"

const pageProject = consoleProject()

describe("Comments activation from the Console", () => {
  it.each([
    "export default defineComments()",
    "export const comments = defineComments(); export default defineComments()",
  ])("keeps the Operations inbox for a default export: %s", async (source) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-console-"))
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "server/comments.ts"), source)
      const config: UserConfig = { root, base: "/portal/" }
      for (const plugin of [hubComments(), consoleVitePlugin({ console: productionConsole, sections: ["comments"] })]) {
        const hook = plugin.config
        if (!hook) throw new Error("Expected a config hook")
        await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      }
      const generated = await readFile(resolveGeneratedConsolePlugin(root), "utf8")
      expect(generated).toContain('"kind":"operation-view"')
      expect(generated).toContain('"operation":"comments.list"')
      expect(generated).not.toContain('"visit":')
      expect(generated).not.toContain("readCommentsConsoleRecords")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the Operations inbox for the comments option without server/comments.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-console-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const config: UserConfig = { root }
      for (const plugin of [hubComments({ enabled: true }), consoleVitePlugin({ console: productionConsole, sections: ["comments"] })]) {
        const hook = plugin.config
        if (!hook) throw new Error("Expected a config hook")
        await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      }
      const generated = await readFile(resolveGeneratedConsolePlugin(root), "utf8")
      expect(generated).toContain('"operation":"comments.list"')
      expect(generated).not.toContain("readCommentsConsoleRecords")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { base: "/", mount: "" },
    { base: "/portal/", mount: "/portal" },
    { base: "https://cdn.example/portal/", mount: "" },
    { base: "/_nuxt/", __vitehubAppBaseURL: "/portal/", mount: "/portal" },
  ])("registers Comments routes and opens no page session from the Console: %j", async ({ mount, ...bases }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-console-"))
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "server/comments.ts"), "export const comments = defineComments()\n")
      const config: UserConfig & { nitro?: { handlers: Array<{ route: string }>, plugins: string[] } } = { root, ...bases }
      for (const plugin of [hubComments(), consoleVitePlugin({ console: productionConsole, sections: ["comments"] })]) {
        const hook = plugin.config
        if (!hook) throw new Error("Expected a config hook")
        await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      }
      const route = config.nitro!.handlers.find(handler => handler.route.endsWith("/comments/**"))!.route.slice(0, -3)
      expect(route).toBe(`${mount}/api/_vitehub/comments`)
      const generated = await readFile(resolveGeneratedConsolePlugin(root), "utf8")
      expect(generated).not.toContain('"visit":')
      expect(config.nitro!.handlers).toEqual(expect.arrayContaining([expect.objectContaining({ route: `${mount}/_vitehub/page/session` })]))

      // The hosted Console opens no page session of the app. Comments keeps its own route.
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return Response.json({ ok: true, value: { sections: ["comments"], contributions: describeConsoleContributedSections(["comments"]) } })
        return new Response()
      })
      vi.stubGlobal("fetch", fetch)
      setConsoleProject({ origin: "", base: mount })
      await loadConsoleNavigation(`/_vitehub/api/sections?${encodeURIComponent(root)}`)
      expect(fetch.mock.calls.map(([url]) => url)).not.toContain(`${mount}/_vitehub/page/session`)
    }
    finally {
      setConsoleProject(pageProject)
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
