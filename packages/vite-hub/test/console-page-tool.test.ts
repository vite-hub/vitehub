import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { readViteHubPageSession } from "@vite-hub/internal/runtime/page-tools-shared"

import { addConsolePageToolRoutes } from "../src/console/nitro.ts"
import { consolePageToolScript, writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access-policy.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { isAuthAdmin } from "../src/console/runtime/server/page-auth.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"
import { consoleDocumentPath, consolePageBase, consolePageLink } from "../src/page/console-link.ts"

import type { ConsoleAuthorize, ConsoleAuthorizeContext } from "../src/console/auth.ts"
import type { ConsolePageUser } from "../src/console/runtime/server/page-tool.ts"

const people: Record<string, ConsolePageUser> = {
  admin: { user: { id: "u1", role: "admin" }, console: true, signOut: "/api/auth/sign-out" },
  member: { user: { id: "u2", role: "user" }, console: false, signOut: "/api/auth/sign-out" },
}

/** Installs the Console page tool with an Auth reader that takes the person from a `person` cookie. */
function install(app: object): void {
  installConsolePageTool(app, {
    script: consolePageToolScript,
    user: async request => people[/person=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? ""],
  })
}

async function tools(app: object, person?: string) {
  const request = new Request("http://site.test/portal/_vitehub/page/session", { headers: person ? { cookie: `person=${person}` } : {} })
  return readViteHubPageSession(await (await respondViteHubPageSession(app, request)).json()).tools
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
  installConsoleDevelopment("/work/app", false)
})

afterEach(() => {
  installConsoleDevelopment("/work/app", false)
  installConsoleAccess({ mode: "open" })
})

describe("who gets the Console link", () => {
  it("shows it to every visitor of a development server", async () => {
    installConsoleDevelopment("/work/app", true)
    installConsoleAccess({ mode: "local" })
    const app = {}
    install(app)
    expect(await tools(app)).toEqual([{ id: "console", label: "Console", icon: "i-lucide-square-terminal", script: `/portal${consolePageToolScript}` }])
  })

  it("shows it to Auth admins only without console.authorize", async () => {
    installConsoleAccess({ mode: "token" })
    const app = {}
    install(app)
    expect(await tools(app)).toEqual([])
    expect(await tools(app, "member")).toEqual([])
    expect((await tools(app, "admin")).map(tool => tool.id)).toEqual(["console"])
  })

  it("never shows it for the local policy outside a development server", async () => {
    installConsoleAccess({ mode: "local" })
    const app = {}
    install(app)
    expect(await tools(app, "admin")).toEqual([])
  })

  it("asks console.authorize with via: page and the Auth user", async () => {
    const contexts: ConsoleAuthorizeContext[] = []
    const authorize = vi.fn<ConsoleAuthorize>((context) => {
      contexts.push(context)
      if (context.via !== "page") return false
      return context.user?.id === "u2" ? { sections: ["content"] } : false
    })
    installConsoleAccess({ mode: "token", authorize })
    const app = {}
    install(app)
    expect(await tools(app)).toEqual([])
    // The policy decides, not the admin role.
    expect(await tools(app, "admin")).toEqual([])
    expect((await tools(app, "member")).map(tool => tool.id)).toEqual(["console"])
    expect(contexts.map(context => [context.via, context.user?.id])).toEqual([["page", undefined], ["page", "u1"], ["page", "u2"]])
  })

  it.each([
    { result: true, shown: true },
    { result: { sections: ["kv:read"] }, shown: true },
    { result: { sections: [] }, shown: false },
    { result: false, shown: false },
    { result: new Response(null, { status: 401 }), shown: false },
  ])("shows it for an authorize result of $result: $shown", async ({ result, shown }) => {
    installConsoleAccess({ mode: "token", authorize: () => result })
    const app = {}
    install(app)
    expect((await tools(app)).length).toBe(shown ? 1 : 0)
  })

  it("keeps it off when the Auth reader fails", async () => {
    installConsoleAccess({ mode: "token" })
    const app = {}
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    installConsolePageTool(app, { script: consolePageToolScript, user: () => Promise.reject(new Error("no database")) })
    expect(await tools(app)).toEqual([])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe("the Auth admin check", () => {
  const admin = (options?: Record<string, unknown>) => ({ id: "admin", ...(options ? { options } : {}) })

  it("follows Better Auth's admin() roles and user ids", () => {
    expect(isAuthAdmin([admin()], { id: "a", role: "admin" })).toBe(true)
    expect(isAuthAdmin([admin()], { id: "a", role: "user,admin" })).toBe(true)
    expect(isAuthAdmin([admin()], { id: "a", role: "user" })).toBe(false)
    expect(isAuthAdmin([admin()], { id: "a" })).toBe(false)
    expect(isAuthAdmin([admin({ adminRoles: ["owner"] })], { id: "a", role: "admin" })).toBe(false)
    expect(isAuthAdmin([admin({ adminRoles: "owner, staff" })], { id: "a", role: "staff" })).toBe(true)
    expect(isAuthAdmin([admin({ adminUserIds: ["a"] })], { id: "a", role: "user" })).toBe(true)
  })

  it("counts nobody as an admin without the admin() plugin", () => {
    expect(isAuthAdmin([], { id: "a", role: "admin" })).toBe(false)
    expect(isAuthAdmin(undefined, { id: "a", role: "admin" })).toBe(false)
  })
})

describe("the Console link", () => {
  it("opens the project overview of the app at its base", () => {
    expect(consolePageLink("https://app.example.com", "")).toBe("https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2F")
    expect(consolePageLink("https://app.example.com", "/portal")).toBe("https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com%2Fportal&path=%2F")
    expect(consolePageLink("http://localhost:3000", "")).toBe("https://console.vitehub.dev/open?project=http%3A%2F%2Flocalhost%3A3000&path=%2F")
  })

  it("has no link for an origin that the Console cannot open", () => {
    expect(consolePageLink("http://192.168.0.38:3000", "")).toBeUndefined()
  })

  it("opens the Content document that the page shows", () => {
    expect(consolePageLink("https://app.example.com", "", ["posts:hello#title", "posts:hello#body"]))
      .toBe("https://console.vitehub.dev/open?project=https%3A%2F%2Fapp.example.com&path=%2Fcontent%2Fposts%2Fhello")
    expect(consoleDocumentPath(["settings#title"])).toBe("/content/settings")
    expect(consoleDocumentPath(["docs:guide/intro page#title"])).toBe("/content/docs/guide/intro%20page")
    // A layout singleton next to the post: the document with an id wins.
    expect(consoleDocumentPath(["settings#title", "posts:hello#title"])).toBe("/content/posts/hello")
    // Two posts, or nothing that parses: the project overview.
    expect(consoleDocumentPath(["posts:a#title", "posts:b#title"])).toBe("/")
    expect(consoleDocumentPath(["", "not a field"])).toBe("/")
  })

  it("reads the app base from the URL of its script", () => {
    expect(consolePageBase("/_vitehub/console/assets/page-tool.js")).toBe("")
    expect(consolePageBase("/portal/_vitehub/console/assets/page-tool.js")).toBe("/portal")
  })
})

describe("a Console app without Comments", () => {
  it("adds the page tools pill to its pages", async () => {
    installConsoleAccess({ mode: "token" })
    const app: { fetch: (request: Request) => Promise<Response> } = { fetch: async () => new Response("<html><body></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }) }
    install(app)
    const page = await (await app.fetch(new Request("https://site.test/"))).text()
    expect(page).toContain("data-vitehub-page-tools")
  })

  it("serves the session route, the loader, and the segment script", () => {
    const nitro: { handlers?: Array<{ handler: string, route?: string }>, publicAssets?: Array<{ baseURL?: string, dir: string }> } = {}
    addConsolePageToolRoutes(nitro, "/runtime", "/portal")
    expect(nitro.handlers).toEqual([{ handler: "/runtime/server/page-session.js", route: "/portal/_vitehub/page/session" }])
    expect(nitro.publicAssets?.map(({ baseURL, dir }) => ({ baseURL, dir }))).toEqual([
      { baseURL: "/portal/_vitehub/console/assets", dir: "/runtime/page-tool" },
      { baseURL: "/portal/_vitehub/page/assets", dir: "/runtime/page" },
    ])
  })

  it("keeps the session route and the loader that Comments added first", () => {
    const comments = { handler: "/comments/page-session.mjs", route: "/_vitehub/page/session" }
    const loader = { baseURL: "/_vitehub/page/assets", dir: "/comments/dist/page", maxAge: 300 }
    const nitro = { handlers: [comments], publicAssets: [loader] }
    addConsolePageToolRoutes(nitro, "/runtime")
    addConsolePageToolRoutes(nitro, "/runtime")
    expect(nitro.handlers).toEqual([comments])
    expect(nitro.publicAssets.map(asset => asset.dir)).toEqual(["/comments/dist/page", "/runtime/page-tool"])
  })

  it("installs the Console page tool from the generated plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tool-"))
    try {
      const file = join(root, "plugin.mjs")
      const write = (sections: string[], pageTool?: { base: string }) => writeConsoleNitroPlugin({ file, projectRoot: root, sections, catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token" }, ...(pageTool ? { pageTool } : {}) })
      await write(["auth"], { base: "/portal/" })
      const withAuth = await readFile(file, "utf8")
      expect(withAuth).toContain(`import { installConsolePageTool } from ${JSON.stringify(generatedModules.consolePageTool)}`)
      expect(withAuth).toContain(`export default function viteHubConsolePlugin(nitroApp) { installConsolePageTool(nitroApp, { base: "/portal/", script: ${JSON.stringify(consolePageToolScript)}, user: async request => (await import(${JSON.stringify(generatedModules.consolePageAuth)})).consolePageAuthUser(request) }) }`)
      await write([], { base: "/" })
      const withoutAuth = await readFile(file, "utf8")
      expect(withoutAuth).toContain(`installConsolePageTool(nitroApp, { base: "/", script: ${JSON.stringify(consolePageToolScript)} })`)
      expect(withoutAuth).not.toContain(generatedModules.consolePageAuth)
      await write([])
      const off = await readFile(file, "utf8")
      expect(off).toContain("export default function viteHubConsolePlugin() {}")
      expect(off).not.toContain(generatedModules.consolePageTool)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers the page tools routes for console: true, and none for the development RPC alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-routes-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const routes = async (options: Parameters<typeof consoleVitePlugin>[0]) => {
        const hook = consoleVitePlugin(options).config
        if (!hook) throw new TypeError("Expected a Console config hook.")
        const config: { root: string, base: string, nitro?: { handlers?: Array<{ route?: string }> } } = { root, base: "/" }
        await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
        return config.nitro?.handlers?.map(handler => handler.route)
      }
      expect(await routes({ console: {}, sections: [] })).toContain("/_vitehub/page/session")
      expect(await routes({ rpcOnly: true, sections: [] })).not.toContain("/_vitehub/page/session")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
