import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { syncPackedWorkspaceDependencies } from "../../internal/test-utils/published-types.js"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const childProcessTimeout = 60_000
const packedPackages = [
  "agent",
  "box",
  "history",
  "markdown-template",
  "rate-limit",
  "runtime",
  "source",
  "workspace",
] as const

async function runPnpm(args: string[], cwd: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath?.includes("pnpm") ? process.execPath : "corepack"
  const commandArgs = npmExecPath?.includes("pnpm") ? [npmExecPath, ...args] : ["pnpm", ...args]
  try {
    await execFileAsync(command, commandArgs, {
      cwd,
      env: { ...process.env, CI: "true" },
      killSignal: "SIGKILL",
      timeout: childProcessTimeout,
    })
  }
  catch (error) {
    const output = error as Error & { stderr?: string, stdout?: string }
    throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port")
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function readTree(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? await readTree(path) : /\.m?js$/.test(entry.name) ? await readFile(path, "utf8") : ""
  }))).join("\n")
}

async function requestWhenReady(url: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url)
    }
    catch (error) {
      lastError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  throw lastError
}

it("packages optional Agent runtimes into immutable Nuxt output", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-nuxt-runtime-"))
  try {
    await mkdir(join(root, "server", "api"), { recursive: true })
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      dependencies: {
        "@vite-hub/agent": "file:./vite-hub-agent-0.0.1.tgz",
        nuxt: "4.4.8",
        vite: "8.2.0",
      },
      packageManager: "pnpm@10.33.0",
      private: true,
      type: "module",
    }, null, 2)}\n`, "utf8")
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n\nblockExoticSubdeps: false\n", "utf8")
    await writeFile(join(root, "app.vue"), "<template><div>ViteHub runtime proof</div></template>\n", "utf8")
    await writeFile(join(root, "server", "api", "proof.get.ts"), `
import { defineAgent, runAgentInline } from "@vite-hub/agent"
import { mcp } from "@vite-hub/agent/capabilities"

const agent = defineAgent({ driver: { env: { PATH: "" }, kind: "codex" }, runtime: false })
const capability = mcp({
  servers: {
    proof: { transport: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  },
})

export default defineEventHandler(async () => {
  let mcp = "loaded"
  let provider = "loaded"
  try {
    await capability.resolve?.({ tools: { add() {} } } as never)
  }
  catch (error) {
    const message = String(error)
    if (message.includes("Cannot find") && message.includes("@ai-sdk/mcp")) throw error
    mcp = "loaded-before-transport-error"
  }
  try {
    await runAgentInline(agent, { memo: (_key, create) => create(), runtime: "vite", waitUntil() {} }, { prompt: "runtime proof" })
  }
  catch (error) {
    const message = String(error)
    if (message.includes("Cannot find") && message.includes("@t3tools/provider-runtime")) throw error
    provider = "loaded-before-cli-error"
  }
  return { mcp, provider }
})
`, "utf8")

    await syncPackedWorkspaceDependencies(
      root,
      workspaceRoot,
      packedPackages.map(name => `@vite-hub/${name}`),
    )
    await Promise.all(packedPackages.map(name =>
      runPnpm(["pack", "--pack-destination", root], join(workspaceRoot, "packages", name))))
    await runPnpm(["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"], root)
    await runPnpm(["exec", "nuxt", "build"], root)

    const outputServer = join(root, ".output", "server")
    const output = await readTree(outputServer)
    expect(output).toContain("createMCPClient")
    expect(output).not.toContain('["@ai-sdk", "mcp"].join("/")')

    await rename(join(root, "node_modules"), join(root, "source-node_modules"))
    const port = await availablePort()
    const child = spawn(process.execPath, [join(outputServer, "index.mjs")], {
      cwd: root,
      env: { ...process.env, NITRO_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", chunk => stderr += chunk)
    const exited = once(child, "exit")
    try {
      const response = await requestWhenReady(`http://127.0.0.1:${port}/api/proof`)
      expect(response.status, `${await response.clone().text()}\n${stderr}`).toBe(200)
      await expect(response.json()).resolves.toEqual({
        mcp: "loaded-before-transport-error",
        provider: "loaded-before-cli-error",
      })
    }
    finally {
      child.kill()
      await exited
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
