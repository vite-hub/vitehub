import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { addConsolePageHandlers } from "../src/console/nitro.ts"
import { consoleRuntimeRoot } from "../src/console/plugin.ts"
import consoleNotEmbeddedHandler from "../src/console/runtime/server/not-embedded.ts"
import { consoleVitePlugin, resolveConsoleOptions, type ConsoleOptions } from "../src/console/vite.ts"
import { hostManagedAuthorize, productionConsole } from "./support/console-authorize.ts"

type NitroHandler = { handler: string, lazy?: boolean, method?: string, middleware?: boolean, route?: string }
type NitroConfig = { handlers: NitroHandler[], plugins: string[], publicAssets: Array<{ baseURL?: string, dir: string }> }

const page = join(consoleRuntimeRoot, "server/page.get.js")
const notEmbedded = join(consoleRuntimeRoot, "server/not-embedded.js")
const signIn = join(consoleRuntimeRoot, "server/sign-in.js")
const client = join(consoleRuntimeRoot, "server/client.get.js")

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-console-embed-"))
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "console-embed" })}\n`)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

async function configure(console: ConsoleOptions, command: "build" | "serve", extra: Record<string, unknown> = {}): Promise<NitroConfig> {
  const plugin = consoleVitePlugin({ console, preset: "node", sections: ["kv"] })
  const hook = plugin.config
  if (!hook) throw new TypeError("Expected a Console config hook.")
  const config: { nitro?: NitroConfig, root: string } = { root, ...extra }
  await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [config, { command, mode: command === "build" ? "production" : "development" }])
  if (!config.nitro) throw new TypeError("Expected the Console Nitro configuration.")
  return config.nitro
}

const routesOf = (nitro: NitroConfig, handler: string) => nitro.handlers.filter(entry => entry.handler === handler).map(entry => entry.route)
const assetBases = (nitro: NitroConfig) => nitro.publicAssets.map(asset => asset.baseURL)
const generatedPlugin = () => readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")

describe("console.embed", () => {
  it("leaves the Console pages and assets out of a production build by default", async () => {
    const nitro = await configure(productionConsole, "build")

    expect(routesOf(nitro, notEmbedded)).toEqual(["/_vitehub", "/_vitehub/**"])
    expect(nitro.handlers.find(entry => entry.handler === notEmbedded)).toMatchObject({ lazy: true })
    expect(routesOf(nitro, page)).toEqual([])
    expect(routesOf(nitro, client)).toEqual([])
    expect(routesOf(nitro, signIn)).toEqual([])
    // The data routes, MCP, and the page tools session stay.
    expect(nitro.handlers.map(entry => entry.route)).toEqual(expect.arrayContaining(["/_vitehub/rpc/**", "/_vitehub/env/manage", "/_vitehub/schedules/run", "/_vitehub/mcp", "/_vitehub/page/session"]))
    expect(assetBases(nitro)).toEqual(["/_vitehub/.well-known/skills", "/_vitehub/page/assets"])
    // The Console page tool script is a Console asset, so the pill gets no Console button. The session still answers.
    await expect(generatedPlugin()).resolves.toContain('installConsolePageTool(nitroApp, { base: "/", embed: false })')
    // Console links, such as the Agent `/debug` reply, open the hosted Console.
    await expect(generatedPlugin()).resolves.toContain('globalThis[Symbol.for("vitehub.console.hosted")] = true')
  })

  it("serves the Console pages and assets in a production build with embed: true", async () => {
    const nitro = await configure({ ...productionConsole, embed: true }, "build")

    expect(routesOf(nitro, page)).toEqual(["/_vitehub", "/_vitehub/**"])
    expect(routesOf(nitro, notEmbedded)).toEqual([])
    expect(routesOf(nitro, client)).toEqual(["/api/_vitehub/console/client.js"])
    expect(assetBases(nitro)).toEqual(["/_vitehub/assets", "/_vitehub/.well-known/skills", "/_vitehub/page/assets"])
    await expect(generatedPlugin()).resolves.toContain('installConsolePageTool(nitroApp, { base: "/" })')
    await expect(generatedPlugin()).resolves.not.toContain("vitehub.console.hosted")
  })

  it.each([undefined, false])("always serves the Console pages in vite dev with embed %s", async (embed) => {
    const nitro = await configure({ auth: false, embed }, "serve")

    expect(routesOf(nitro, page)).toEqual(["/_vitehub", "/_vitehub/**"])
    expect(routesOf(nitro, notEmbedded)).toEqual([])
    expect(assetBases(nitro)).toContain("/_vitehub/assets")
    await expect(generatedPlugin()).resolves.toContain('installConsolePageTool(nitroApp, { base: "/" })')
    await expect(generatedPlugin()).resolves.not.toContain("vitehub.console.hosted")
  })

  it("rejects a value that is not a boolean", () => {
    expect(() => resolveConsoleOptions({ auth: "app", embed: "yes" })).toThrow("console.embed must be true or false.")
  })
})

describe("console.auth false in production", () => {
  it.each([{ auth: false as const }, { auth: false as const, authorize: hostManagedAuthorize }])("fails a production build with %o", async (console) => {
    await expect(configure(console, "build")).rejects.toMatchObject({
      code: "VITE_HUB_B0020",
      message: expect.stringContaining('console.auth false is for development. Use auth: "app" with an app Auth Definition, or a Console Auth config object.'),
    })
  })

  it("keeps working in vite dev and in CLI discovery", async () => {
    await expect(configure({ auth: false }, "serve")).resolves.toBeDefined()
    await expect(configure({ auth: false }, "build", { vitehubCliDiscovery: true })).resolves.toBeDefined()
  })
})

describe("Nuxt Console page handlers", () => {
  it("keeps only the skill and the built-in app Auth sign-in page without embed", () => {
    const nitro: { handlers?: NitroHandler[], publicAssets?: Array<{ baseURL?: string, dir: string }> } = {}
    addConsolePageHandlers(nitro, consoleRuntimeRoot, "/portal/", "/_vitehub/sign-in", false)

    expect(nitro.handlers?.filter(entry => entry.handler === signIn)).toEqual([{ handler: signIn, middleware: true, route: "/portal/_vitehub/sign-in" }])
    expect(nitro.handlers?.filter(entry => entry.handler === notEmbedded).map(entry => entry.route)).toEqual(["/portal/_vitehub", "/portal/_vitehub/**"])
    expect(nitro.handlers?.some(entry => entry.handler === page)).toBe(false)
    expect(nitro.publicAssets?.map(asset => asset.baseURL)).toEqual(["/portal/_vitehub/.well-known/skills", "/portal/_vitehub/page/assets"])
  })

  it("adds no sign-in middleware for an app sign-in page without embed", () => {
    const nitro: { handlers?: NitroHandler[] } = {}
    addConsolePageHandlers(nitro, consoleRuntimeRoot, undefined, "/sign-in", false)
    expect(nitro.handlers?.some(entry => entry.handler === signIn)).toBe(false)
  })

  it("replaces the not-embedded answer when embed turns on", () => {
    const nitro: { handlers?: NitroHandler[], publicAssets?: Array<{ baseURL?: string, dir: string }> } = {}
    addConsolePageHandlers(nitro, consoleRuntimeRoot, undefined, "/_vitehub/sign-in", false)
    addConsolePageHandlers(nitro, consoleRuntimeRoot, undefined, "/_vitehub/sign-in", true)

    expect(nitro.handlers?.filter(entry => entry.handler === signIn).map(entry => entry.route)).toEqual(["/_vitehub/**", "/_vitehub"])
    expect(nitro.handlers?.filter(entry => entry.handler === page).map(entry => entry.route)).toEqual(["/_vitehub", "/_vitehub/**"])
    expect(nitro.handlers?.some(entry => entry.handler === notEmbedded)).toBe(false)
    expect(nitro.publicAssets?.map(asset => asset.baseURL)).toContain("/_vitehub/assets")
  })
})

describe("the not-embedded answer", () => {
  it("links the hosted Console to the project origin and base", async () => {
    const response = consoleNotEmbeddedHandler({ req: { url: "http://internal/portal/_vitehub/kv", headers: new Headers({ host: "app.example.com", "x-forwarded-proto": "https" }) } })

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("The Console is not embedded in this app. Open it at https://console.vitehub.dev and link https://app.example.com/portal, or set console.embed: true.\n")
  })
})
