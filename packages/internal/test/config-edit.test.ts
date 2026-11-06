import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

import { editViteHubConfig, locateViteHubConfig } from "../src/config-edit.ts"

import type { ConfigEdit } from "../src/config-edit.ts"

const root = join(import.meta.dirname, "../../..")
const expected: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/config-corpus.json"), "utf8"))
const skipped = new Set(["node_modules", ".nuxt", ".output", "dist"])
const configFile = /[/\\](?:vite|nuxt)\.config\.[cm]?[jt]s$/
const snippetFence = /^(\s*)(`{3,})(?:ts|js) \[((?:vite|nuxt)\.config\.(?:ts|mts|js))\]/

interface CorpusEntry { key: string, file: string, code: string }

function* filesIn(directory: string): Generator<string> {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) yield* filesIn(path)
    }
    else {
      yield path
    }
  }
}

function repositoryConfigs(): CorpusEntry[] {
  const packages = readdirSync(join(root, "packages"))
  const directories = ["fixtures", "playground", "docs", ...packages.flatMap(name => [`packages/${name}/examples`, `packages/${name}/test/fixtures`])]
  const entries: CorpusEntry[] = []
  for (const directory of directories) {
    for (const path of filesIn(join(root, directory))) {
      if (!configFile.test(path)) continue
      const code = readFileSync(path, "utf8")
      if (code.includes("vite-hub")) entries.push({ key: relative(root, path), file: path, code })
    }
  }
  return entries
}

function docsSnippets(): CorpusEntry[] {
  const entries: CorpusEntry[] = []
  for (const path of filesIn(join(root, "docs/content"))) {
    if (!path.endsWith(".md")) continue
    const lines = readFileSync(path, "utf8").split("\n")
    let count = 0
    for (let index = 0; index < lines.length; index++) {
      const match = snippetFence.exec(lines[index] ?? "")
      if (!match) continue
      const [, indent = "", fence = "", file = ""] = match
      const closing = new RegExp(`^\\s*${fence}\\s*$`)
      const body: string[] = []
      for (index++; index < lines.length && !closing.test(lines[index] ?? ""); index++) body.push((lines[index] ?? "").slice(indent.length))
      entries.push({ key: `${relative(root, path)}#${++count}`, file, code: `${body.join("\n")}\n` })
    }
  }
  return entries
}

function classify(entries: readonly CorpusEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map(({ key, file, code }) => {
    const result = locateViteHubConfig(file, code)
    return [key, result.ok ? "ok" : result.reason]
  }))
}

function expectedFor(predicate: (key: string) => boolean): Record<string, string> {
  return Object.fromEntries(Object.entries(expected).filter(([key]) => predicate(key)))
}

function edit(file: string, code: string, edits: readonly ConfigEdit[]): string {
  const result = editViteHubConfig(file, code, edits)
  if (!result.ok) throw new Error(`Edit failed: ${result.reason}`)
  return result.code
}

describe("config corpus", () => {
  const repository = repositoryConfigs()
  const docs = docsSnippets()

  it("classifies every vite-hub config in the repository", () => {
    expect(classify(repository)).toEqual(expectedFor(key => !key.includes(".md#")))
  })

  it("classifies every config snippet in the docs", () => {
    expect(classify(docs)).toEqual(expectedFor(key => key.includes(".md#")))
  })

  it("set then delete gives back the original bytes", () => {
    const failures: string[] = []
    for (const { key, file, code } of [...repository, ...docs]) {
      const located = locateViteHubConfig(file, code)
      if (!located.ok) continue
      const probe = "kv" in located.site.keys ? "__probe" : "kv"
      const set = editViteHubConfig(file, code, [{ op: "set", key: probe, value: true }])
      const restored = set.ok ? editViteHubConfig(file, set.code, [{ op: "delete", key: probe }]) : set
      if (!restored.ok || restored.code !== code) failures.push(key)
    }
    expect(failures).toEqual([])
  })
})

describe("editViteHubConfig", () => {
  const vite = (options: string, quote = "\"") => `import { vitehub } from ${quote}vite-hub${quote}\n\nexport default {\n  plugins: [vitehub(${options})],\n}\n`

  it("keeps sibling formatting", () => {
    expect(edit("vite.config.ts", vite("{ preset: \"node\" }"), [{ op: "set", key: "kv", value: true }]))
      .toBe(vite("{ preset: \"node\", kv: true }"))
    expect(edit("vite.config.ts", vite("{\n    preset: \"node\"\n  }"), [{ op: "set", key: "kv", value: true }]))
      .toBe(vite("{\n    preset: \"node\",\n    kv: true\n  }"))
    expect(edit("vite.config.ts", vite("{\n    preset: \"node\", // host\n  }"), [{ op: "set", key: "blob", value: { driver: "fs" } }]))
      .toBe(vite("{\n    preset: \"node\", // host\n    blob: { driver: \"fs\" },\n  }"))
    expect(edit("vite.config.ts", vite("{ preset: 'node' }", "'"), [{ op: "set", key: "queue", value: ["jobs", "mail"] }]))
      .toBe(vite("{ preset: 'node', queue: ['jobs', 'mail'] }", "'"))
    const tabs = "import { vitehub } from \"vite-hub\"\n\nexport default {\n\tplugins: [\n\t\tvitehub({\n\t\t\tpreset: \"node\",\n\t\t}),\n\t],\n}\n"
    expect(edit("vite.config.ts", tabs, [{ op: "set", key: "kv", value: true }]))
      .toBe(tabs.replace("\t\t\tpreset: \"node\",\n", "\t\t\tpreset: \"node\",\n\t\t\tkv: true,\n"))
    const crlf = vite("{\n    preset: \"node\",\n  }").replaceAll("\n", "\r\n")
    const added = edit("vite.config.ts", crlf, [{ op: "set", key: "kv", value: true }])
    expect(added).toBe(vite("{\n    preset: \"node\",\n    kv: true,\n  }").replaceAll("\n", "\r\n"))
    expect(edit("vite.config.ts", added, [{ op: "delete", key: "kv" }])).toBe(crlf)
  })

  it("writes options into a call without them and removes them when empty", () => {
    const withKv = edit("vite.config.ts", vite(""), [{ op: "set", key: "kv", value: true }])
    expect(withKv).toBe(vite("{ kv: true }"))
    expect(edit("vite.config.ts", withKv, [{ op: "delete", key: "kv" }])).toBe(vite(""))
  })

  it("replaces a value and quotes keys that are not identifiers", () => {
    expect(edit("vite.config.ts", vite("{ preset: \"node\", kv: true }"), [
      { op: "set", key: "preset", value: "cloudflare" },
      { op: "set", key: "x-key", value: null },
      { op: "delete", key: "kv" },
    ])).toBe(vite("{ preset: \"cloudflare\", \"x-key\": null }"))
  })

  it("returns manual for variable options, mergeConfig, computed keys, and two calls", () => {
    const head = "import { vitehub } from \"vite-hub\"\nimport { mergeConfig } from \"vite\"\nconst options = { kv: true }\n"
    expect(locateViteHubConfig("vite.config.ts", `${head}export default { plugins: [vitehub(options)] }\n`)).toEqual({ ok: false, reason: "dynamic-options", line: 4 })
    expect(locateViteHubConfig("vite.config.ts", `${head}export default { plugins: [vitehub(mergeConfig(options, {}))] }\n`)).toMatchObject({ ok: false, reason: "dynamic-options" })
    expect(locateViteHubConfig("vite.config.ts", `${head}export default { plugins: [vitehub({ [name]: true })] }\n`)).toMatchObject({ ok: false, reason: "computed-key" })
    expect(locateViteHubConfig("vite.config.ts", `${head}export default { plugins: [vitehub(), vitehub()] }\n`)).toMatchObject({ ok: false, reason: "multiple-vitehub" })
    expect(locateViteHubConfig("vite.config.ts", "export default {}\n")).toEqual({ ok: false, reason: "no-vitehub" })
    expect(locateViteHubConfig("vite.config.ts", "export default {\n")).toMatchObject({ ok: false, reason: "parse-error" })
    expect(editViteHubConfig("vite.config.ts", `${head}export default { plugins: [vitehub(options)] }\n`, [{ op: "set", key: "kv", value: false }]))
      .toMatchObject({ ok: false, reason: "dynamic-options" })
  })

  it("accepts aliased and default imports", () => {
    const aliased = "import { vitehub as hub } from \"vite-hub\"\nexport default defineConfig(() => ({ plugins: [hub({ kv: true })] }))\n"
    expect(locateViteHubConfig("vite.config.ts", aliased)).toEqual({
      ok: true,
      site: { form: "vite-call", options: { start: aliased.indexOf("{ kv"), end: aliased.indexOf("})") + 1 }, keys: { kv: { kind: "literal", value: true } }, spread: false },
    })
    const fallback = "import hub from \"vite-hub\"\nconst config = { plugins: [hub()] }\nexport default config\n"
    expect(locateViteHubConfig("vite.config.ts", fallback)).toMatchObject({ ok: true, site: { form: "vite-call", keys: {} } })
  })

  it.each(["vite.config.cjs", "nuxt.config.cts"])("leaves CommonJS exports manual in %s", (file) => {
    const code = `const { vitehub } = require("vite-hub"); module.exports = { plugins: [vitehub({ kv: true })] }`
    expect(locateViteHubConfig(file, code)).toMatchObject({ ok: false, reason: "dynamic-options" })
    expect(editViteHubConfig(file, code, [{ op: "set", key: "kv", value: false }]))
      .toMatchObject({ ok: false, reason: "dynamic-options" })
  })

  it("reports expression values with their source", () => {
    const code = "import { vitehub } from \"vite-hub\"\nexport default {\n  plugins: [vitehub({\n    agent: process.env.AGENT === \"1\",\n  })],\n}\n"
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({
      ok: true,
      site: { keys: { agent: { kind: "expression", source: "process.env.AGENT === \"1\"", line: 4 } } },
    })
  })

  it("deletes nothing when a spread can supply the key", () => {
    const code = vite("{ ...shared, preset: \"node\" }")
    expect(editViteHubConfig("vite.config.ts", code, [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
    expect(edit("vite.config.ts", code, [{ op: "delete", key: "preset" }])).toBe(vite("{ ...shared }"))
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true, site: { spread: true } })
    expect(edit("vite.config.ts", vite("{ kv: false, ...shared }"), [{ op: "set", key: "kv", value: true }])).toBe(vite("{ ...shared, kv: true }"))
    expect(editViteHubConfig("vite.config.ts", vite("{ kv: true, ...shared }"), [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
    expect(locateViteHubConfig("vite.config.ts", vite("{ kv: true, ...shared }"))).toMatchObject({ ok: true, site: { keys: { kv: { kind: "expression" } } } })
  })

  it("edits the Nuxt tuple and the vitehub key forms", () => {
    const bare = "import viteHubNuxt from \"vite-hub/nuxt\"\n\nexport default defineNuxtConfig({\n  modules: [viteHubNuxt],\n})\n"
    const tuple = edit("nuxt.config.ts", bare, [{ op: "set", key: "preset", value: "node" }])
    expect(tuple).toBe(bare.replace("[viteHubNuxt]", "[[viteHubNuxt, { preset: \"node\" }]]"))
    expect(locateViteHubConfig("nuxt.config.ts", tuple)).toMatchObject({ ok: true, site: { form: "nuxt-module-tuple", keys: { preset: { kind: "literal", value: "node" } } } })
    expect(edit("nuxt.config.ts", tuple, [{ op: "delete", key: "preset" }])).toBe(bare)

    const named = "export default defineNuxtConfig({\n  modules: [\"@nuxt/ui\", [\"vite-hub/nuxt\", { preset: \"node\" }]],\n})\n"
    expect(edit("nuxt.config.ts", named, [{ op: "set", key: "kv", value: true }])).toBe(named.replace("{ preset: \"node\" }", "{ preset: \"node\", kv: true }"))

    const key = "export default defineNuxtConfig({\n  modules: [\"vite-hub/nuxt\"],\n  vitehub: {\n    preset: \"node\",\n  },\n})\n"
    expect(locateViteHubConfig("nuxt.config.ts", key)).toMatchObject({ ok: true, site: { form: "nuxt-config-key" } })
    expect(edit("nuxt.config.ts", key, [{ op: "set", key: "kv", value: true }])).toBe(key.replace("    preset: \"node\",\n", "    preset: \"node\",\n    kv: true,\n"))
    expect(edit("nuxt.config.ts", key, [{ op: "delete", key: "preset" }])).toBe(key.replace("{\n    preset: \"node\",\n  }", "{}"))

    const both = "export default defineNuxtConfig({\n  modules: [[\"vite-hub/nuxt\", { kv: true }]],\n  vitehub: { preset: \"node\" },\n})\n"
    expect(locateViteHubConfig("nuxt.config.ts", both)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true }, preset: { kind: "literal", value: "node" } } } })
    expect(edit("nuxt.config.ts", both, [{ op: "set", key: "preset", value: "vercel" }])).toBe(both.replace("{ kv: true }", "{ kv: true, preset: \"vercel\" }"))
    const overridden = both.replace("{ kv: true }", "{ preset: \"vercel\", kv: true }")
    const deleted = edit("nuxt.config.ts", overridden, [{ op: "delete", key: "preset" }])
    expect(locateViteHubConfig("nuxt.config.ts", deleted)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true } } } })
    expect(deleted).not.toContain("preset")
  })

  it.each([
    'modules: ["vite-hub/nuxt"], vitehub: { kv: true }, ...shared',
    'modules: ["vite-hub/nuxt"], ...shared, vitehub: { kv: true }',
    'vitehub: { kv: true }, ...shared, modules: ["vite-hub/nuxt"]',
    '...shared, modules: ["vite-hub/nuxt"]',
    '...shared, vitehub: { kv: true }',
  ])("leaves Nuxt root spreads manual when they can supply or override options: %s", (properties) => {
    const code = `import viteHubNuxt from "vite-hub/nuxt"\nexport default defineNuxtConfig({ ${properties} })`
    expect(locateViteHubConfig("nuxt.config.ts", code)).toMatchObject({ ok: false, reason: "spread" })
    expect(editViteHubConfig("nuxt.config.ts", code, [{ op: "set", key: "kv", value: false }]))
      .toMatchObject({ ok: false, reason: "spread" })
  })

  it("reads Nuxt options that override a root spread", () => {
    const code = 'export default defineNuxtConfig({ ...shared, modules: ["vite-hub/nuxt"], vitehub: { kv: true } })'
    expect(locateViteHubConfig("nuxt.config.ts", code)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true } } } })
  })

  it("does not evaluate code", () => {
    const sentinel: { __evaluated?: boolean } = globalThis
    const code = "import { vitehub } from \"vite-hub\"\nglobalThis.__evaluated = true\nexport default { plugins: [vitehub({ kv: (globalThis.__evaluated = true) })] }\n"
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true })
    expect(edit("vite.config.ts", code, [{ op: "set", key: "blob", value: true }])).toContain("blob: true")
    expect(sentinel.__evaluated).toBeUndefined()
  })
})
