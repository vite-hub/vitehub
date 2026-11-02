import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { vitehub } from "../src/index.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-custom-domain-"))
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

async function wranglerFor(
  publicUrl: Parameters<typeof vitehub>[0]["publicUrl"],
  wrangler: Record<string, unknown> = {},
  { command = "build", preset = "cloudflare", appRoot = root }: { appRoot?: string, command?: "build" | "serve", preset?: "cloudflare" | "node" } = {},
) {
  const plugin = vitehub({ preset, publicUrl }).find(
    candidate => candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/deployment-preset",
  )
  if (!plugin || typeof plugin !== "object" || !("config" in plugin) || !plugin.config) throw new Error("Missing deployment config hook")
  const handler = typeof plugin.config === "function" ? plugin.config : plugin.config.handler
  const config = { nitro: { cloudflare: { wrangler } }, root: appRoot }
  await Reflect.apply(handler, undefined, [config, { command, mode: "production" }])
  return config.nitro.cloudflare.wrangler
}

describe("vitehub({ publicUrl }) on Cloudflare", () => {
  it("serves the Worker on the custom domain and turns off workers.dev", async () => {
    expect(await wranglerFor("https://calories.example.com/")).toMatchObject({
      routes: [{ custom_domain: true, pattern: "calories.example.com" }],
      workers_dev: false,
    })
  })

  it("keeps the default host for workers.dev, HTTP, and port origins, the function form, development, and other presets", async () => {
    for (const wrangler of [
      await wranglerFor("https://calories.maxi.workers.dev"),
      await wranglerFor("http://calories.example.com"),
      await wranglerFor("https://calories.example.com:8443"),
      await wranglerFor(() => "https://calories.example.com"),
      await wranglerFor(undefined),
      await wranglerFor("https://calories.example.com", {}, { command: "serve" }),
      await wranglerFor("https://calories.example.com", {}, { preset: "node" }),
    ]) {
      expect(wrangler).not.toHaveProperty("routes")
      expect(wrangler).not.toHaveProperty("workers_dev")
    }
  })

  it("leaves routing to the app when its Nitro config or project wrangler file sets it", async () => {
    const routes = [{ pattern: "example.com/*", zone_name: "example.com" }]
    expect(await wranglerFor("https://calories.example.com", { routes })).toEqual(expect.objectContaining({ routes }))
    expect(await wranglerFor("https://calories.example.com", { workers_dev: true })).not.toHaveProperty("routes")

    await writeFile(join(root, "wrangler.jsonc"), "{\n  // Served from the zone.\n  \"route\": \"example.com/*\"\n}\n")
    // Nitro reads the nearest wrangler file from the app root up.
    const appRoot = join(root, "app")
    await mkdir(appRoot)
    const wrangler = await wranglerFor("https://calories.example.com", {}, { appRoot })
    expect(wrangler).not.toHaveProperty("routes")
    expect(wrangler).not.toHaveProperty("workers_dev")
  })
})
