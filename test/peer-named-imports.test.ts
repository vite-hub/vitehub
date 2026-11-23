import { execFile, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { promisify } from "node:util"

import {
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteral,
  type Node,
  ScriptKind,
  ScriptTarget,
} from "typescript"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")
const run = promisify(execFile)

interface PeerImport {
  file: string
  line: number
  name: string
  specifier: string
}

interface Finding {
  file: string
  message: string
  name?: string
  specifier: string
}

const virtualId = /^(?:#|\0|virtual:)/
const vueScript = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script>/g

function peerImports(file: string, source: string, peers: readonly string[]): PeerImport[] {
  const blocks = file.endsWith(".vue")
    ? [...source.matchAll(vueScript)].map(match => ({
        code: match[2]!,
        lineOffset: source.slice(0, match.index + match[1]!.length).split("\n").length - 1,
      }))
    : [{ code: source, lineOffset: 0 }]
  const imports: PeerImport[] = []
  for (const { code, lineOffset } of blocks) {
    const sourceFile = createSourceFile(file, code, ScriptTarget.Latest, true, file.endsWith("x") ? ScriptKind.TSX : ScriptKind.TS)
    const add = (node: Node, name: string, specifier: string) => imports.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset,
      name,
      specifier,
    })
    for (const statement of sourceFile.statements) {
      if (!(isImportDeclaration(statement) || isExportDeclaration(statement))) continue
      if (!statement.moduleSpecifier || !isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (virtualId.test(specifier) || !peers.some(peer => specifier === peer || specifier.startsWith(`${peer}/`))) continue
      const clause = isImportDeclaration(statement) ? statement.importClause : statement
      if (!clause || clause.isTypeOnly) continue
      if (isImportDeclaration(statement) && statement.importClause?.name) add(statement.importClause.name, "default", specifier)
      const bindings = isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause
      if (!bindings || !(isNamedImports(bindings) || isNamedExports(bindings))) continue
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) add(element, (element.propertyName ?? element.name).text, specifier)
      }
    }
  }
  return imports
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value) : []
}

function packagePeers(): Map<string, string[]> {
  const manifests = execFileSync("git", ["ls-files", "--", "packages/*/package.json"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n").filter(Boolean).map((path) => {
      const manifest: { name?: unknown, peerDependencies?: unknown, peerDependenciesMeta?: unknown } = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"))
      return { dir: path.slice(0, -"/package.json".length), manifest }
    })
  const workspace = new Set(manifests.map(({ manifest }) => manifest.name))
  return new Map(manifests.map(({ dir, manifest }) => [
    dir,
    [...new Set([...keysOf(manifest.peerDependencies), ...keysOf(manifest.peerDependenciesMeta)])]
      .filter(peer => !workspace.has(peer) && !peer.startsWith("@types/")),
  ]))
}

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0").filter(file => /^packages\/[^/]+\/src\/.+\.(?:[cm]?[jt]sx?|vue)$/.test(file) && !file.endsWith(".d.ts"))
}

const loader = `
import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
function exportEntry(specifier) {
  const manifest = JSON.parse(readFileSync(findPackageJSON(specifier, import.meta.url), "utf8"))
  return manifest.exports?.["." + specifier.slice(manifest.name.length)] ?? null
}
const result = {}
for (const specifier of JSON.parse(process.argv[1])) {
  try { result[specifier] = { names: Object.keys(await import(specifier)) } }
  catch (error) {
    result[specifier] = { code: error?.code, error: [error?.code, String(error?.message ?? error).split("\\n")[0]].filter(Boolean).join(": ") }
    if (error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") result[specifier].exported = exportEntry(specifier)
  }
}
process.stdout.write("\\n@@exports@@" + JSON.stringify(result))
process.exit(0)
`

interface FailedModule {
  code?: string
  error: string
  exported?: unknown
  names?: undefined
}
type Loaded = Record<string, FailedModule | { error?: undefined, names: string[] }>

function loadsOnlyInBuild(module: FailedModule): boolean {
  if (module.code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") return true
  if (module.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" || module.exported === null || typeof module.exported !== "object") return false
  const conditions = Object.keys(module.exported)
  return conditions.length > 0 && conditions.every(condition => condition === "types")
}

async function loadExports(dir: string, specifiers: string[]): Promise<Loaded> {
  const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", loader, JSON.stringify(specifiers)], {
    cwd: resolve(repoRoot, dir),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  return JSON.parse(stdout.slice(stdout.lastIndexOf("@@exports@@") + "@@exports@@".length)) as Loaded
}

function missingExports(dir: string, imports: readonly PeerImport[], loaded: Loaded): Finding[] {
  const findings: Finding[] = []
  const failed = new Set<string>()
  for (const entry of imports) {
    const module = loaded[entry.specifier]!
    if (module.error !== undefined && loadsOnlyInBuild(module)) continue
    if (module.error !== undefined) {
      if (!failed.has(entry.specifier)) findings.push({ file: dir, message: `${entry.file}:${entry.line}: ${entry.specifier} does not load from ${dir}: ${module.error}`, specifier: entry.specifier })
      failed.add(entry.specifier)
    }
    else if (!module.names.includes(entry.name)) {
      findings.push({ file: entry.file, message: `${entry.file}:${entry.line}: ${entry.specifier} does not export "${entry.name}"`, name: entry.name, specifier: entry.specifier })
    }
  }
  return findings
}

async function peerImportFindings() {
  const peers = packagePeers()
  const byPackage = new Map<string, PeerImport[]>()
  for (const file of trackedSources()) {
    const dir = file.split("/").slice(0, 2).join("/")
    const packagePeerNames = peers.get(dir) ?? []
    if (!packagePeerNames.length) continue
    const path = resolve(repoRoot, file)
    const source = existsSync(path) ? readFileSync(path, "utf8") : execFileSync("git", ["show", `:${file}`], { cwd: repoRoot, encoding: "utf8" })
    const imports = peerImports(file, source, packagePeerNames)
    if (imports.length) byPackage.set(dir, [...byPackage.get(dir) ?? [], ...imports])
  }
  const findings = await Promise.all([...byPackage].map(async ([dir, imports]) =>
    missingExports(dir, imports, await loadExports(dir, [...new Set(imports.map(entry => entry.specifier))]))))
  return { findings: findings.flat(), specifiers: new Set([...byPackage.values()].flat().map(entry => entry.specifier)) }
}

describe("peer named imports", () => {
  it("finds every named import from a peer in the installed version", async () => {
    const { findings, specifiers } = await peerImportFindings()
    expect([...specifiers]).toEqual(expect.arrayContaining(["drizzle-orm", "vue"]))
    expect(findings.map(finding => finding.message), "Missing peer exports. Import a name that the installed peer exports, mark a type-only name with `type`, or update the peer range.").toEqual([])
  }, 120_000)

  it("reads value names from imports and re-exports, with their line", () => {
    const source = [
      "import { drizzle, sql as rawSql } from \"drizzle-orm/pglite\"",
      "export { eq } from \"drizzle-orm\"",
      "import { defineHandler, type H3Event } from \"h3\"",
      "import postgres from \"postgres\"",
      "import h3, { H3 } from \"h3\"",
      "export { default as pg } from \"postgres\"",
    ].join("\n")
    expect(peerImports("packages/kv/src/a.ts", source, ["drizzle-orm", "h3", "postgres"])).toEqual([
      { file: "packages/kv/src/a.ts", line: 1, name: "drizzle", specifier: "drizzle-orm/pglite" },
      { file: "packages/kv/src/a.ts", line: 1, name: "sql", specifier: "drizzle-orm/pglite" },
      { file: "packages/kv/src/a.ts", line: 2, name: "eq", specifier: "drizzle-orm" },
      { file: "packages/kv/src/a.ts", line: 3, name: "defineHandler", specifier: "h3" },
      { file: "packages/kv/src/a.ts", line: 4, name: "default", specifier: "postgres" },
      { file: "packages/kv/src/a.ts", line: 5, name: "default", specifier: "h3" },
      { file: "packages/kv/src/a.ts", line: 5, name: "H3", specifier: "h3" },
      { file: "packages/kv/src/a.ts", line: 6, name: "default", specifier: "postgres" },
    ])
  })

  it("reports a module that does not load once, and each missing name with its file and line", () => {
    const imports = [
      { file: "packages/kv/src/a.ts", line: 1, name: "defineHandler", specifier: "h3" },
      { file: "packages/kv/src/a.ts", line: 2, name: "defineEventHandler", specifier: "h3" },
      { file: "packages/kv/src/b.ts", line: 3, name: "eq", specifier: "drizzle-orm" },
      { file: "packages/kv/src/b.ts", line: 4, name: "sql", specifier: "drizzle-orm" },
    ]
    const loaded: Loaded = { "drizzle-orm": { error: "ERR_MODULE_NOT_FOUND" }, "h3": { names: ["defineHandler"] } }
    expect(missingExports("packages/kv", imports, loaded).map(finding => finding.message)).toEqual([
      "packages/kv/src/a.ts:2: h3 does not export \"defineEventHandler\"",
      "packages/kv/src/b.ts:3: drizzle-orm does not load from packages/kv: ERR_MODULE_NOT_FOUND",
    ])
  })

  it("skips a peer module that only a build can load", () => {
    const imports = [
      { file: "packages/ui/src/a.ts", line: 1, name: "defineShortcuts", specifier: "@nuxt/ui/composables" },
      { file: "packages/ui/src/a.ts", line: 2, name: "default", specifier: "@nuxt/ui/vue-plugin" },
      { file: "packages/ui/src/a.ts", line: 3, name: "x", specifier: "typed" },
      { file: "packages/ui/src/a.ts", line: 4, name: "y", specifier: "missing" },
    ]
    const loaded: Loaded = {
      "@nuxt/ui/composables": { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED", error: "ERR_PACKAGE_IMPORT_NOT_DEFINED: Package import specifier \"#imports\" is not defined" },
      "@nuxt/ui/vue-plugin": { code: "ERR_PACKAGE_PATH_NOT_EXPORTED", error: "ERR_PACKAGE_PATH_NOT_EXPORTED", exported: { types: "./vue-plugin.d.ts" } },
      "missing": { code: "ERR_PACKAGE_PATH_NOT_EXPORTED", error: "ERR_PACKAGE_PATH_NOT_EXPORTED", exported: null },
      "typed": { code: "ERR_PACKAGE_PATH_NOT_EXPORTED", error: "ERR_PACKAGE_PATH_NOT_EXPORTED", exported: { import: "./x.js", types: "./x.d.ts" } },
    }
    expect(missingExports("packages/ui", imports, loaded).map(finding => finding.message)).toEqual([
      "packages/ui/src/a.ts:3: typed does not load from packages/ui: ERR_PACKAGE_PATH_NOT_EXPORTED",
      "packages/ui/src/a.ts:4: missing does not load from packages/ui: ERR_PACKAGE_PATH_NOT_EXPORTED",
    ])
  })

  it("reads Vue script blocks with their file line", () => {
    const source = [
      "<script lang=\"ts\">",
      "import { defineComponent } from \"vue\"",
      "</script>",
      "<template><div /></template>",
      "",
      "<script setup lang=\"ts\" generic=\"T extends Record<string, unknown>\">",
      "import { ref } from \"vue\"",
      "</script>",
    ].join("\n")
    expect(peerImports("packages/ui/src/a.vue", source, ["vue"])).toEqual([
      { file: "packages/ui/src/a.vue", line: 2, name: "defineComponent", specifier: "vue" },
      { file: "packages/ui/src/a.vue", line: 7, name: "ref", specifier: "vue" },
    ])
  })

  it.each([
    ["type-only import", "import type { H3Event } from \"h3\""],
    ["type-only default import", "import type H3 from \"h3\""],
    ["type-only names", "import { type H3Event } from \"h3\""],
    ["type-only re-export", "export type { H3Event } from \"h3\""],
    ["namespace imports and star re-exports", "import * as all from \"h3\"\nexport * from \"h3\""],
    ["a package that is not a peer", "import { defu } from \"defu\""],
    ["a package with a peer name prefix", "import { x } from \"h3-extra\""],
    ["a virtual id", "import { useRuntimeConfig } from \"#imports\""],
    ["a string literal", "const code = `import { defineHandler } from \"h3\"`"],
  ] as const)("ignores %s", (_, source) => {
    expect(peerImports("packages/kv/src/a.ts", source, ["h3", "#imports"])).toEqual([])
  })
})
