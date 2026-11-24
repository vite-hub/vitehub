import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { readViteHubPageSession } from "@vite-hub/internal/runtime/page-tools-shared"

import { writeConsoleAppModule } from "../src/console/app-module.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access-policy.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { siteAccessOperations } from "../src/console/runtime/server/site-access-operation.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { readConsoleProject } from "../src/console/runtime/server/project.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consolePillScript, installConsolePill } from "../src/console/runtime/server/pill.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { consoleDocumentPath, consolePageLink, consoleScriptSource } from "../src/page/console-link.ts"
import { vitehub } from "../src/index.ts"
import { readViteHubVersion } from "../src/version.ts"

import type { Plugin } from "vite"

async function tools(app: object) {
  const request = new Request("http://site.test/portal/_vitehub/page/tools")
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

describe("the Console segment of the Comments pill", () => {
  it("loads its script from the ViteHub Console, with the app base in the query", () => {
    expect(consolePillScript("0.4.0")).toBe("https://console.vitehub.dev/page/0.4.0/page-tool.js?base=")
    expect(consolePillScript("0.4.0", "/portal/")).toBe("https://console.vitehub.dev/page/0.4.0/page-tool.js?base=%2Fportal")
    expect(consolePillScript("0.0.0-pr.12+abc", "/")).toBe("https://console.vitehub.dev/page/0.0.0-pr.12%2Babc/page-tool.js?base=")
  })

  it("shows it to every visitor of a development server", async () => {
    const app = {}
    installConsolePill(app, { base: "/portal/", development: true, version: "0.4.0" })
    expect(await tools(app)).toEqual([{ id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "https://console.vitehub.dev/page/0.4.0/page-tool.js?base=%2Fportal" }])
  })

  it("shows it only to Site access people with the console role, and never asks console.authorize", async () => {
    const authorize = vi.fn(() => true)
    installConsoleAccess({ mode: "token", authorize })
    const app = {}
    installConsolePill(app, { version: "0.4.0" })
    expect(await tools(app)).toEqual([])
    expect(authorize).not.toHaveBeenCalled()
  })
})

describe("vitehub() with Comments", () => {
  it.each([true, false])("hands the Console segment to the Comments pill only with the Console on: %s", async (consoleOn) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-pill-comments-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugins = vitehub({ comments: true, console: consoleOn && { auth: false }, host: "node" }).flat(3) as Plugin[]
      const comments = plugins.find(plugin => plugin?.name === "@vite-hub/comments/vite")
      const hook = comments?.config
      if (!hook) throw new TypeError("Expected the Comments config hook.")
      await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [{ root, nitro: { plugins: [] } }, { command: "build", mode: "production" }])
      const generated = await readFile(join(root, ".vitehub/nitro/comments/plugin.mjs"), "utf8")
      if (consoleOn) {
        expect(generated).toMatch(/import \{ installConsolePill as pillSegment0 \} from "[^"]+\/console\/runtime\/server\/pill\.(?:ts|js)"/)
        expect(generated).toContain(`...{"version":${JSON.stringify(readViteHubVersion())}}`)
      }
      else {
        expect(generated).not.toContain("installConsolePill")
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
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

  it("opens the Console that served its script, at the app base in the script query", () => {
    const script = "https://console.example.com/page/0.4.0/0123456789abcdef/page-tool.js"
    expect(consoleScriptSource(`${script}?base=%2Fportal`)).toEqual({ base: "/portal", consoleOrigin: "https://console.example.com" })
    expect(consoleScriptSource(script)).toEqual({ base: "", consoleOrigin: "https://console.example.com" })
    for (const base of ["portal", "//evil.example", "/portal/", "/a/../b", "/a?b"]) {
      expect(consoleScriptSource(`${script}?base=${encodeURIComponent(base)}`).base).toBe("")
    }
    expect(consolePageLink("https://app.example.com", "/portal", [], "https://console.example.com"))
      .toBe("https://console.example.com/open?project=https%3A%2F%2Fapp.example.com%2Fportal&path=%2F")
  })
})

describe("a Console app without Comments", () => {
  it("has a Console app module with no Nitro plugin and no page tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-app-module-"))
    try {
      const file = join(root, "app.mjs")
      await writeConsoleAppModule({ file, projectRoot: root, sections: ["kv"], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token" }, site: true })
      const generated = await readFile(file, "utf8")
      expect(generated).not.toContain("export default")
      expect(generated).not.toMatch(/page-?tool|consolePill/i)
      const registration = /installConsoleSections\([^,]+, (\[[^\n]*?\])/.exec(generated)
      expect(registration?.[1]).toBe('["kv","site"]')
      installConsoleSections(root, JSON.parse(registration![1]!))
      expect(generated).toContain("siteAccessOperations")
      installConsoleOperations([{ operations: siteAccessOperations, plugin: "vite-hub" }])
      const project = await readConsoleProject({ access: { mode: "token", sections: "all" }, surface: "console", user: null })
      expect(project.operations).toContain("site.access")
      await writeConsoleAppModule({ file, projectRoot: root, sections: ["kv"], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", hiddenSections: ["site"] }, site: true })
      expect(await readFile(file, "utf8")).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serves no page tools route and no public /_vitehub assets but the skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-routes-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const nitro = async (options: Parameters<typeof consoleVitePlugin>[0]) => {
        const hook = consoleVitePlugin(options).config
        if (!hook) throw new TypeError("Expected a Console config hook.")
        const config: { root: string, base: string, nitro?: { handlers?: Array<{ route?: string }>, plugins?: string[], publicAssets?: Array<{ baseURL?: string }> } } = { root, base: "/" }
        await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command: "serve", mode: "development" }])
        return config.nitro
      }
      for (const options of [{ console: {}, sections: [] }, { rpcOnly: true, sections: [] }]) {
        const config = await nitro(options)
        expect(config?.handlers?.map(handler => handler.route)).not.toContain("/_vitehub/page/tools")
        expect(config?.plugins ?? []).toEqual([])
        expect((config?.publicAssets ?? []).map(asset => asset.baseURL)).not.toContain("/_vitehub/console/assets")
        expect((config?.publicAssets ?? []).map(asset => asset.baseURL)).not.toContain("/_vitehub/page/assets")
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
