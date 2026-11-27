import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { nitro } from "nitro/vite"
import { createBuilder } from "vite"
import { expect, it, vi } from "vitest"

import { installedOperationRegistry, installOperationRegistryLoader } from "@vite-hub/internal/operation-registry"

import viteHubConsoleOperationLoader from "../src/console/runtime/operation-loader.ts"
import { installConsoleRuntime } from "../src/console/runtime/server/runtime.ts"
import { vitehub } from "../dist/index.js"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"

it("loads the Console operations on first use, not at startup", async () => {
  const install = vi.fn()
  installConsoleRuntime(async () => install)
  viteHubConsoleOperationLoader()
  try {
    expect(install).not.toHaveBeenCalled()
    await installedOperationRegistry()
    expect(install).toHaveBeenCalledOnce()
  } finally {
    installOperationRegistryLoader(undefined)
  }
})

it("serves operations for an inline Agent before any Console request", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-inline-operations-"))
  try {
    const ci = await consoleTestKey()
    for (const [name, value] of Object.entries(ci.env)) vi.stubEnv(name, value)
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
    await mkdir(join(root, "server/routes/_vitehub"), { recursive: true })
    await writeFile(join(root, "server/routes/_vitehub/[slug].ts"), "export default () => 'app route'\n")
    await writeFile(join(root, "server/routes/inline.get.ts"), `
import { defineAgent, runAgent } from "vite-hub/agent"
import { operations } from "vite-hub/agent/capabilities"
const agent = defineAgent({
  capabilities: [operations({ include: ["project.get"] })],
  driver: { run: ({ tools }) => tools?.project_get ? "ready" : "missing" },
  runtime: false,
})
export default async () => {
  const [error, result] = await runAgent(agent, { prompt: "Check operations" })
  return { error, output: result?.output }
}
`)
    const publicUrl = "https://app.example.test"
    const builder = await createBuilder({ configFile: false, logLevel: "silent", plugins: [nitro({ preset: "standard" }), vitehub({ console: true, host: "node", publicUrl })], root })
    await builder.buildApp()
    const output: { default: { fetch(request: Request): Promise<Response> } } = await import(pathToFileURL(join(root, ".output/server/index.mjs")).href)
    const fetch = (path: string) => output.default.fetch(new Request(`${publicUrl}${path}`))
    const inline = await fetch("/inline")
    expect(await inline.json()).toEqual({ output: "ready" })
    expect(await (await fetch("/_vitehub/custom")).text()).toBe("app route")
    const signed = await signedRpcRequest({ headers: { host: new URL(publicUrl).host, origin: publicUrl }, key: ci.key, operation: "project.get", url: `${publicUrl}/_vitehub/rpc` })
    const rpc = await output.default.fetch(signed)
    expect(rpc.status, await rpc.clone().text()).toBe(200)
    expect(rpc.headers.get("content-type")).toContain("application/json")
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { force: true, recursive: true })
  }
}, 120_000)
