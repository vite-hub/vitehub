import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineComments } from "@vite-hub/comments"
import { createCommentsHandler, defineCommentsPlugin, viteHubPageSessionHandler } from "@vite-hub/comments/runtime"
import { hubComments } from "@vite-hub/comments/vite"
import { H3 } from "h3"
import { describe, expect, it, vi } from "vitest"

import { describeConsoleContributedSections } from "../src/console/contributions.ts"
import { loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"
import { consoleVitePlugin, resolveGeneratedConsolePlugin } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

import type { UserConfig } from "vite"

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
      for (const plugin of [hubComments(), consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, preset: "node", sections: ["comments"] })]) {
        const hook = plugin.config
        if (!hook) throw new Error("Expected a config hook")
        await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      }
      const generated = await readFile(resolveGeneratedConsolePlugin(root, undefined, undefined), "utf8")
      expect(generated).toContain('"kind":"operation-view"')
      expect(generated).toContain('"operation":"comments.list"')
      expect(generated).not.toContain('"visit":')
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
  ])("loads the shared page session for Comments: %j", async ({ mount, ...bases }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-console-"))
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "server/comments.ts"), "export const comments = defineComments()\n")
      const config: UserConfig & { nitro?: { handlers: Array<{ route: string }>, plugins: string[] } } = { root, ...bases }
      for (const plugin of [hubComments(), consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, preset: "node", sections: ["comments"] })]) {
        const hook = plugin.config
        if (!hook) throw new Error("Expected a config hook")
        await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      }
      const route = config.nitro!.handlers.find(handler => handler.route.endsWith("/comments/**"))!.route.slice(0, -3)
      expect(route).toBe(`${mount}/api/_vitehub/comments`)
      const generated = await readFile(resolveGeneratedConsolePlugin(root, undefined, undefined), "utf8")
      expect(generated).not.toContain('"visit":')
      expect(config.nitro!.handlers).toEqual(expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/page/session" })]))

      const comments = defineComments({ authorize: () => true })
      const app = new H3()
        .all(`${route}/**`, createCommentsHandler({ comments, realtime: false }))
        .all(`${mount}/_vitehub/page/session`, viteHubPageSessionHandler)
      defineCommentsPlugin({ comments, database: () => undefined, overlay: `${route}/assets/overlay.js` })(app)
      let session: Response | undefined
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return Response.json({ ok: true, value: { sections: ["comments"], contributions: describeConsoleContributedSections(["comments"]) } })
        session = await app.fetch(new Request(`http://site.test${url}`, init))
        return session
      })
      vi.stubGlobal("fetch", fetch)
      const consoleMount = mount
      await loadConsoleNavigation(`${consoleMount}/api/_vitehub/console/sections?${encodeURIComponent(root)}`)
      await vi.waitFor(() => expect(session?.status).toBe(200))
      expect(session?.headers.get("set-cookie")).toContain("vitehub-tools=1")
      expect(fetch).toHaveBeenLastCalledWith(`${mount}/_vitehub/page/session`, { credentials: "same-origin", headers: { accept: "application/json" } })
    }
    finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
