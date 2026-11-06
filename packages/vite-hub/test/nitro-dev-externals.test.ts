import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { nitroDevInlineMatcher, nitroOnlyId, nodeLoadableViteHubPackages } from "../src/internal/nitro-dev-externals.ts"

const root = mkdtempSync(join(tmpdir(), "vitehub-nitro-dev-externals-"))
afterAll(() => rmSync(root, { force: true, recursive: true }))

function writePackage(name: string, files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const directory = join(root, "node_modules", name)
  const packageJson = join(directory, "package.json")
  mkdirSync(directory, { recursive: true })
  writeFileSync(packageJson, JSON.stringify({ name, type: "module", exports: { ".": "./dist/index.js" }, files: ["dist"], ...manifest }))
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), code)
  }
  return packageJson
}

writePackage("@vite-hub/runtime", { "dist/index.js": "export const runtime = 1\n" })
writePackage("@vite-hub/forge", { "dist/index.js": "import { hash } from \"ohash\"\nexport { runtime } from \"@vite-hub/runtime\"\n", "dist/git.js": "export const git = () => import(\"node:child_process\")\n" })
writePackage("@vite-hub/kv", { "dist/index.js": "import config from \"#vitehub/kv/config\"\nexport default config\n" })
writePackage("@vite-hub/schedule", { "dist/index.js": "export { kv } from \"@vite-hub/kv\"\n" })
writePackage("@vite-hub/env", { "dist/index.js": "export const env = 1\n", "dist/internal/agent.js": "export * from \"@vite-hub/agent/env-identity\"\n" })
writePackage("@vite-hub/agent", { "dist/index.js": "export {}\n", "dist/env-identity.js": "import registry from \"#vitehub/agent/registry\"\nexport { registry }\n" })
writePackage("@vite-hub/source", { "dist/index.js": "import { HTTPError } from \"h3\"\nexport { HTTPError }\n" })
writePackage("@vite-hub/docs", { "dist/index.js": "import { useRuntimeConfig } from \"nitropack/runtime\"\nexport { useRuntimeConfig }\n" })
writePackage("@vite-hub/content", { "dist/index.js": "import { useStorage } from \"#imports\"\nexport { useStorage }\n" })
writePackage("@vite-hub/ui", { "dist/index.js": "import devtools from \"@vue/devtools-api\"\nexport { devtools }\n" })
writePackage("@vite-hub/cli", { "dist/index.js": "import { kv } from \"vite-hub/kv\"\nexport { kv }\n" })
writePackage("@vite-hub/unbuilt", {})
const viteHub = writePackage("vite-hub", {}, {
  dependencies: Object.fromEntries(["agent", "cli", "content", "docs", "env", "forge", "kv", "missing", "schedule", "source", "ui", "unbuilt"].map(name => [`@vite-hub/${name}`, "0.0.0"])),
})

describe("Nitro 2 development externals", () => {
  const nodePackages = nodeLoadableViteHubPackages(viteHub, nitroOnlyId(["#imports", "@vue/devtools-api"]))

  it("lets Node load packages that import no Nitro alias, also through other ViteHub packages", () => {
    expect([...nodePackages].sort()).toEqual(["@vite-hub/forge", "@vite-hub/runtime"])
  })

  it.each([
    ["a generated alias", "@vite-hub/kv"],
    ["a package that imports a generated alias", "@vite-hub/schedule"],
    ["a subpath of a package that imports a generated alias", "@vite-hub/env"],
    ["H3, which ViteHub bundles as H3 2", "@vite-hub/source"],
    ["the Nitro runtime", "@vite-hub/docs"],
    ["a Nuxt alias", "@vite-hub/content"],
    ["a bare id from the Nitro alias table", "@vite-hub/ui"],
    ["the vite-hub facade", "@vite-hub/cli"],
    ["no code that it can read", "@vite-hub/unbuilt"],
    ["no installed copy", "@vite-hub/missing"],
  ])("bundles a package that imports %s", (_reason, name) => {
    expect(nodePackages.has(name)).toBe(false)
    expect(nitroDevInlineMatcher(nodePackages)(name)).toBe(true)
  })

  it("matches package ids and resolved paths, and nothing outside ViteHub", () => {
    const inline = nitroDevInlineMatcher(new Set(["@vite-hub/forge"]))
    expect(inline("vite-hub")).toBe(true)
    expect(inline("vite-hub/kv")).toBe(true)
    expect(inline("@vite-hub/kv/runtime")).toBe(true)
    expect(inline("/app/node_modules/.pnpm/@vite-hub+kv@0.0.0/node_modules/@vite-hub/kv/dist/index.js")).toBe(true)
    expect(inline("@vite-hub/forge")).toBe(false)
    expect(inline("@vite-hub/forge/github")).toBe(false)
    expect(inline("C:\\app\\node_modules\\@vite-hub\\forge\\dist\\index.js")).toBe(false)
    expect(inline("@vite-hub/forge-next")).toBe(true)
    expect(inline("vite-hub-plugin")).toBe(false)
    expect(inline("ohash")).toBe(false)
    expect(inline.name).toBe("vite-hub/nitro-dev-inline")
  })
})
