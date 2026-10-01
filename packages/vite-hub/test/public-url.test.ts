import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeConfig, type Plugin } from "vite"
import { describe, expect, it } from "vitest"
import { vitehub } from "../src/index.ts"

function publicUrlPlugin(publicUrl: Parameters<typeof vitehub>[0]["publicUrl"]): Plugin {
  const plugin = vitehub({ preset: "node", publicUrl })
    .find((candidate): candidate is Plugin => !!candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/public-url")
  if (!plugin) throw new Error("Missing public URL plugin.")
  return plugin
}

function define(plugin: Plugin, root: string, command: "build" | "serve") {
  // SAFETY: The plugin reads only the config root and command, which this fixture supplies.
  const hook = plugin.config as (config: { root: string }, env: { command: string }) => { define?: Record<string, string> } | undefined
  return hook({ root }, { command })?.define
}

describe("vitehub({ publicUrl })", () => {
  it("defines one origin, or one origin per discovered Agent, for builds only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-public-url-"))
    try {
      for (const name of ["bot", "bot-dev"]) {
        await mkdir(join(root, "server/agents", name), { recursive: true })
        await writeFile(join(root, "server/agents", name, "agent.ts"), "export default {}\n")
      }
      expect(define(publicUrlPlugin("https://agents.example.com/"), root, "build")).toEqual({
        __VITEHUB_PUBLIC_URL__: JSON.stringify({ url: "https://agents.example.com" }),
      })
      const byAgent = publicUrlPlugin(agent => agent === "bot" ? "https://agent.example.com" : "https://agent-dev.example.com")
      expect(define(byAgent, root, "build")).toEqual({
        __VITEHUB_PUBLIC_URL__: JSON.stringify({ agents: { bot: "https://agent.example.com", "bot-dev": "https://agent-dev.example.com" } }),
      })
      expect(define(byAgent, root, "serve")).toBeUndefined()
      expect(() => define(publicUrlPlugin("https://agents.example.com/app"), root, "build")).toThrow("publicUrl must be an http(s) origin")
      expect(() => define(publicUrlPlugin(""), root, "build")).toThrow("publicUrl must be an http(s) origin")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps an existing noExternal: true for server environments", () => {
    // SAFETY: The hook reads only the environment consumer and resolve options, which this fixture supplies.
    const hook = publicUrlPlugin(undefined).configEnvironment as (name: string, config: { consumer: string, resolve?: { noExternal?: true | string[] } }) => { resolve: { noExternal: unknown } } | undefined
    expect(hook("nitro", { consumer: "server", resolve: { noExternal: true } })).toBeUndefined()
    expect(hook("nitro", { consumer: "server", resolve: { noExternal: ["vite-hub"] } })?.resolve.noExternal).toEqual(["@vite-hub/runtime"])
    const existing = { consumer: "server", resolve: { noExternal: ["vite-hub", "@vite-hub/runtime"] } }
    expect(hook("nitro", existing)).toBeUndefined()
    const config = { consumer: "server", resolve: { noExternal: ["vite-hub"] } }
    expect(mergeConfig(config, hook("nitro", config) ?? {}).resolve.noExternal).toEqual(["vite-hub", "@vite-hub/runtime"])
    expect(hook("client", { consumer: "client" })).toBeUndefined()
  })
})
