import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { listWorkspacePackageInfos } from "../../packages/internal/src/workspace-inventory.ts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../..")

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  }
  catch (error) {
    const failed = error as Error & { stderr?: string | Buffer, stdout?: string | Buffer }
    throw new Error(`${command} ${args.join(" ")} failed\n${failed.stdout || ""}${failed.stderr || ""}`, { cause: error })
  }
}

async function packWorkspace(packDir: string) {
  const overrides: Record<string, string> = {}
  for (const info of listWorkspacePackageInfos(repoRoot).filter(info => !info.private)) {
    const manifest = JSON.parse(await readFile(join(info.dir, "package.json"), "utf8")) as { name: string, version: string }
    await run("pnpm", ["--filter", info.packageName, "pack", "--pack-destination", packDir], repoRoot)
    const tarball = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`
    overrides[manifest.name] = `file:${join(packDir, tarball)}`
  }
  return overrides
}

function workspaceConfig(overrides: Record<string, string>) {
  return [
    "packages:",
    "  - .",
    "allowBuilds:",
    "  esbuild: true",
    "overrides:",
    "  \"@napi-rs/wasm-runtime\": \"1.1.6\"",
    "  \"@nestjs/core\": \"11.2.3\"",
    ...Object.entries(overrides)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
    "",
  ].join("\n")
}

async function buildWorker(appDir: string, entry: string, name: string) {
  const meta = join(appDir, `dist/${name}-meta.json`)
  await mkdir(join(appDir, "dist"), { recursive: true })
  await run("pnpm", [
    "exec",
    "wrangler",
    "deploy",
    entry,
    "--name",
    `vitehub-source-${name}`,
    "--dry-run",
    "--outfile",
    `dist/${name}.js`,
    "--metafile",
    meta,
    "--compatibility-date",
    "2026-08-13",
    "--compatibility-flag",
    "nodejs_compat",
  ], appDir)
  return JSON.parse(await readFile(meta, "utf8")) as {
    inputs: Record<string, unknown>
    outputs: Record<string, { imports?: Array<{ external?: boolean, path: string }> }>
  }
}

describe("packed Source capability closures", () => {
  it("keeps lightweight Workers MCP-free and ships MCP privately when selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-closures-"))
    const appDir = join(root, "app")
    const packDir = join(root, "packs")

    try {
      await Promise.all([mkdir(join(appDir, "src"), { recursive: true }), mkdir(packDir, { recursive: true })])
      const overrides = await packWorkspace(packDir)
      await Promise.all([
        writeFile(join(appDir, "package.json"), JSON.stringify({
          name: "vitehub-source-closure-consumer",
          private: true,
          type: "module",
          dependencies: { "vite-hub": overrides["vite-hub"] },
          devDependencies: { typescript: "6.0.3", wrangler: "4.72.0" },
        }, null, 2)),
        writeFile(join(appDir, "pnpm-workspace.yaml"), workspaceConfig(overrides)),
        writeFile(join(appDir, "tsconfig.json"), JSON.stringify({
          compilerOptions: { lib: ["ESNext", "DOM"], module: "ESNext", moduleResolution: "Bundler", noEmit: true, strict: true, target: "ESNext" },
          include: ["src/**/*.ts"],
        }, null, 2)),
        writeFile(join(appDir, "src/lightweight.ts"), `
import { custom } from "vite-hub/source"
import { file } from "vite-hub/source/file"
import { github } from "vite-hub/source/github"
import { glob } from "vite-hub/source/glob"
import { markdown } from "vite-hub/source/markdown"

const local = custom({ name: "local", getKeys: async () => ["ok"], getItem: async key => ({ key, content: "ok" }) })
const inline = file({ content: "ok", workspacePath: "inline.txt" })
const remote = github({ auth: false, repo: "vite-hub/vitehub" })
const matches = glob({ include: "**/*.md" })
const document = markdown({ content: "# ok", workspacePath: "readme.md" })

export default { fetch: () => new Response(local.name + inline.name + remote.name + matches.name + document.name) }
`),
        writeFile(join(appDir, "src/mcp.ts"), `
import { mcpResources } from "vite-hub/source/mcp"

const source = mcpResources({ server: { listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) } })
export default { fetch: async () => new Response(JSON.stringify(await source.getKeys({ rootDir: "." }))) }
`),
        writeFile(join(appDir, "src/transports.ts"), `
import type { McpResourcesTransport } from "vite-hub/source/mcp"

const sourceTransport: McpResourcesTransport = {
  async close() {},
  async start() {},
  async send(message) {
    if (message.id !== undefined) this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {} })
  },
}
void sourceTransport
`),
        writeFile(join(appDir, "mcp-run.mjs"), `
import { mcpResources } from "vite-hub/source/mcp"

const transport = {
  async close() {},
  async start() {},
  async send(message) {
    if (message.id === undefined) return
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { resources: {} }, serverInfo: { name: "packed", version: "1" } }
      : message.method === "resources/list"
        ? { resources: [{ uri: "resource://packed/readme", name: "readme", mimeType: "text/plain" }] }
        : { contents: [{ uri: "resource://packed/readme", mimeType: "text/plain", text: "packed MCP runtime ok" }] }
    queueMicrotask(() => this.onmessage({ jsonrpc: "2.0", id: message.id, result }))
  },
}
const source = mcpResources({ server: { transport } })
const item = await source.getItem("packed/readme.txt", { rootDir: process.cwd() })
if (item.content !== "packed MCP runtime ok") throw new Error(String(item.content))
console.log(item.content)
`),
      ])

      await run("pnpm", ["install", "--no-hoist", "--strict-peer-dependencies"], appDir)
      await run("pnpm", ["exec", "tsc", "--noEmit"], appDir)

      const lightweight = await buildWorker(appDir, "src/lightweight.ts", "lightweight")
      const lightweightInputs = Object.keys(lightweight.inputs).join("\n")
      expect(lightweightInputs).not.toMatch(/@modelcontextprotocol|mcp-resources|pkce-challenge/)
      expect(await readFile(join(appDir, "dist/lightweight.js"), "utf8")).not.toMatch(/@modelcontextprotocol|pkce-challenge/)

      const mcp = await buildWorker(appDir, "src/mcp.ts", "mcp")
      expect(Object.keys(mcp.inputs).join("\n")).toContain("@vite-hub/source/dist/mcp.js")
      const externalMcpImports = Object.values(mcp.outputs)
        .flatMap(output => output.imports || [])
        .filter(entry => entry.external && /@modelcontextprotocol|pkce-challenge/.test(entry.path))
      expect(externalMcpImports).toEqual([])

      const runtime = await run("node", ["mcp-run.mjs"], appDir)
      expect(runtime.stdout).toContain("packed MCP runtime ok")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }, 600_000)
})
