import { ownModule } from "@vite-hub/internal/build/paths"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { agentInvocationsVitePlugin } from "../src/agent-invocations-vite.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const libsqlModule = ownModule(import.meta.url, "internal/agent-invocations-libsql")
const agentRoot = resolve(packageRoot, "../agent")
const internalSource = resolve(packageRoot, "../internal/src")
type PackageExports = Record<string, { import?: string }>
const exportsOf = (root: string): PackageExports => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports
const viteHubExports = exportsOf(packageRoot)
const agentExports = exportsOf(agentRoot)
// A static `import` or `export ... from` that is not type-only, or a dynamic `import()` with a literal specifier.
const valueImport = /^(?:import|export)\s+(?!type\s)(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

function exportSource(root: string, exports: PackageExports, subpath: string): string | undefined {
  const target = exports[subpath]?.import
  return target ? join(root, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")) : undefined
}

/** The source file of a relative, `vite-hub/*`, `@vite-hub/agent/*`, or `@vite-hub/internal/*` specifier. */
function sourceFile(specifier: string, importer?: string): string | undefined {
  if (specifier.startsWith(`${packageRoot}/`)) return specifier.replace(`${packageRoot}/dist/`, `${packageRoot}/src/`).replace(/\.js$/, ".ts")
  if (specifier.startsWith(".") && importer) return resolve(dirname(importer), specifier)
  if (specifier.startsWith("vite-hub/")) return exportSource(packageRoot, viteHubExports, `./${specifier.slice("vite-hub/".length)}`)
  if (specifier.startsWith("@vite-hub/agent/")) return exportSource(agentRoot, agentExports, `./${specifier.slice("@vite-hub/agent/".length)}`)
  if (specifier.startsWith("@vite-hub/internal/")) return join(internalSource, `${specifier.slice("@vite-hub/internal/".length)}.ts`)
}

/**
 * The files and packages that the default journal plugin can load through static and dynamic imports. A bundler
 * keeps every one of them in the output, and workerd compiles every module of a Worker when an isolate starts.
 */
function journalGraph(code: string): { files: Set<string>, packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (specifier: string, importer?: string): void => {
    const file = sourceFile(specifier, importer)
    if (!file) {
      packages.add(specifier)
      return
    }
    if (files.has(file) || !existsSync(file)) return
    files.add(file)
    for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(valueImport)) visit((match[1] ?? match[2])!, file)
  }
  for (const match of withoutComments(code).matchAll(valueImport)) visit((match[1] ?? match[2])!)
  return { files, packages }
}

/** The journal plugin that the Agent Invocations Vite plugin generates for a host and command. */
async function generatedPlugin(options: { command: "build" | "serve", d1?: string, databaseUrl?: string, host: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-journal-libsql-"))
  try {
    const plugin = agentInvocationsVitePlugin({
      database: false,
      ...(options.databaseUrl ? { default: { databaseUrl: options.databaseUrl } } : {}),
      host: options.host,
      resolveD1Binding: () => options.d1,
    })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected an Agent Invocations config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook
    await Reflect.apply(configHandler, {}, [{ root }, { command: options.command, mode: "production" }])
    return await readFile(join(root, ".vitehub/nitro/agent/invocations.mjs"), "utf8")
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("default Agent Invocation journal libSQL driver", () => {
  it.each(["DB", undefined])("keeps libSQL out of a Cloudflare production build with D1 binding %s", async (d1) => {
    const generated = await generatedPlugin({ command: "build", d1, host: "cloudflare" })
    if (d1) expect(generated).toContain(`d1: { binding: "DB"`)
    const { files, packages } = journalGraph(generated)
    expect(files).toContain(join(agentRoot, "src/invocations/default-core.ts"))
    expect(packages).not.toContain("@libsql/client")
  })

  it.each([
    { command: "serve", host: "cloudflare" },
    { command: "build", databaseUrl: "libsql://journal.example.com", host: "cloudflare" },
    { command: "build", host: "node" },
    { command: "build", host: "vercel" },
  ] as const)("loads libSQL when the journal can select SQLite or libSQL: %j", async (options) => {
    const generated = await generatedPlugin(options)
    expect(generated).toContain(`libsql: () => import(${JSON.stringify(libsqlModule)})`)
    expect(journalGraph(generated).packages).toContain("@libsql/client")
  })
})
