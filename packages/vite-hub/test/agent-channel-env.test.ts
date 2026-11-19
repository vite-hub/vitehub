import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveConfig } from "vite"
import { beforeEach, expect, it, vi } from "vitest"

import { hubEnv } from "@vite-hub/env/vite"
import { agentChannelEnvPlugin } from "../src/agent-channel-env.ts"
import { assertFeaturePackages } from "../src/internal/optional-owners.ts"

import type { Plugin } from "vite"

vi.mock("../src/internal/optional-owners.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/optional-owners.ts")>()
  return { ...original, assertFeaturePackages: vi.fn() }
})

beforeEach(() => vi.mocked(assertFeaturePackages).mockClear())

it("adds canonical sources for discovered gateway and Channel fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-gateway-canonical-"))
  try {
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "support.ts"), [
      'import { codexDriver, defineAgent } from "vite-hub/agent"',
      'import { cliproxy, cloudflareAccess } from "vite-hub/gateways"',
      'import { telegram } from "vite-hub/channels"',
      'export default defineAgent({ driver: codexDriver({ gateway: cliproxy({ headers: cloudflareAccess() }) }), channels: { telegram: telegram() } })',
    ].join("\n"))
    const envPlugin = hubEnv()
    // Match the framework integration: discovery runs before Server Env reads the config.
    const configHook = envPlugin.config
    if (!configHook) throw new Error("Expected the Server Env config hook")
    envPlugin.config = { order: "post", handler: "handler" in configHook ? configHook.handler : configHook }
    // SAFETY: hubEnv uses the same Vite plugin API across workspace peer dependency contexts.
    await resolveConfig({ root, configFile: false, plugins: [agentChannelEnvPlugin(), envPlugin as Plugin] }, "build")
    const description = await readFile(join(root, ".vitehub", "env", "description.mjs"), "utf8")
    expect(description).toContain("VITEHUB_CLIPROXY_API_KEY")
    expect(description).toContain("VITEHUB_CLOUDFLARE_ACCESS_CLIENT_SECRET")
    expect(description).toContain("VITEHUB_TELEGRAM_BOT_TOKEN")
    const server = await readFile(join(root, ".vitehub", "env", "server.mjs"), "utf8")
    expect(server).toContain("VITEHUB_CLIPROXY_API_KEY")
    expect(server).toContain("CLIPROXY_API_KEY")
    // A Telegram Channel does not need the optional Forge package.
    expect(assertFeaturePackages).not.toHaveBeenCalled()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ["a github() Channel", 'import { github } from "vite-hub/channels"', "channels: { github: github() }"],
  ["the forge() Capability", 'import { forge } from "vite-hub/agent/capabilities"', 'capabilities: [forge({ repositories: ["acme/web"] })]'],
])("asks for @vite-hub/forge when an Agent uses %s", async (_name, importLine, option) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-forge-feature-"))
  try {
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "reviewer.ts"), [
      'import { defineAgent } from "vite-hub/agent"',
      importLine,
      `export default defineAgent({ driver: { model: "openai/gpt-5.1-mini" }, ${option} })`,
    ].join("\n"))
    await resolveConfig({ root, configFile: false, plugins: [agentChannelEnvPlugin()] }, "build")
    expect(assertFeaturePackages).toHaveBeenCalledWith(["forge"])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
