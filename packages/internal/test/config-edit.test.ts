import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

import { editViteHubConfig, insertViteHubConfig, locateViteHubConfig } from "../src/config-edit.ts"

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
  // Fix classification inputs so unrelated docs additions do not invalidate the expectations.
  // The round-trip test below still covers every config in the current docs.
  const docsSamples: CorpusEntry[] = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/config-docs.json"), "utf8"))

  it("classifies every vite-hub config in the repository", () => {
    expect(classify(repository)).toEqual(expectedFor(key => !key.includes(".md#")))
  })

  it("classifies the docs config samples", () => {
    expect(classify(docsSamples)).toEqual(expectedFor(key => key.includes(".md#")))
  })

  it("set then delete gives back the original bytes unless a spread prevents deletion", () => {
    const failures: string[] = []
    for (const { key, file, code } of [...repository, ...docs]) {
      const located = locateViteHubConfig(file, code)
      if (!located.ok) continue
      const probe = "kv" in located.site.keys ? "__probe" : "kv"
      const set = editViteHubConfig(file, code, [{ op: "set", key: probe, value: true }])
      const restored = set.ok ? editViteHubConfig(file, set.code, [{ op: "delete", key: probe }]) : set
      if (located.site.spread && set.ok) {
        expect(restored, key).toMatchObject({ ok: false, reason: "spread" })
        continue
      }
      if (!restored.ok || restored.code !== code) failures.push(key)
    }
    expect(failures).toEqual([])
  })
})

describe("editViteHubConfig", () => {
  const vite = (options: string, quote = "\"") => `import { vitehub } from ${quote}vite-hub${quote}\n\nexport default {\n  plugins: [vitehub(${options})],\n}\n`

  it("keeps sibling formatting", () => {
    expect(edit("vite.config.ts", vite("{ host: \"node\" }"), [{ op: "set", key: "kv", value: true }]))
      .toBe(vite("{ host: \"node\", kv: true }"))
    expect(edit("vite.config.ts", vite("{\n    host: \"node\"\n  }"), [{ op: "set", key: "kv", value: true }]))
      .toBe(vite("{\n    host: \"node\",\n    kv: true\n  }"))
    expect(edit("vite.config.ts", vite("{\n    host: \"node\", // host\n  }"), [{ op: "set", key: "blob", value: { driver: "fs" } }]))
      .toBe(vite("{\n    host: \"node\", // host\n    blob: { driver: \"fs\" },\n  }"))
    expect(edit("vite.config.ts", vite("{ host: 'node' }", "'"), [{ op: "set", key: "queue", value: ["jobs", "mail"] }]))
      .toBe(vite("{ host: 'node', queue: ['jobs', 'mail'] }", "'"))
    const tabs = "import { vitehub } from \"vite-hub\"\n\nexport default {\n\tplugins: [\n\t\tvitehub({\n\t\t\thost: \"node\",\n\t\t}),\n\t],\n}\n"
    expect(edit("vite.config.ts", tabs, [{ op: "set", key: "kv", value: true }]))
      .toBe(tabs.replace("\t\t\thost: \"node\",\n", "\t\t\thost: \"node\",\n\t\t\tkv: true,\n"))
    const crlf = vite("{\n    host: \"node\",\n  }").replaceAll("\n", "\r\n")
    const added = edit("vite.config.ts", crlf, [{ op: "set", key: "kv", value: true }])
    expect(added).toBe(vite("{\n    host: \"node\",\n    kv: true,\n  }").replaceAll("\n", "\r\n"))
    expect(edit("vite.config.ts", added, [{ op: "delete", key: "kv" }])).toBe(crlf)
  })

  it("writes options into a call without them and removes them when empty", () => {
    const withKv = edit("vite.config.ts", vite(""), [{ op: "set", key: "kv", value: true }])
    expect(withKv).toBe(vite("{ kv: true }"))
    expect(edit("vite.config.ts", withKv, [{ op: "delete", key: "kv" }])).toBe(vite(""))
  })

  it.each([
    ["vite.config.ts", vite("OPTIONS")],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: [[\"vite-hub/nuxt\", OPTIONS]] })\n"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], vitehub: OPTIONS })\n"],
  ])("preserves comments in otherwise empty options in %s (%#)", (file, template) => {
    for (const options of ["{ /* keep this note */ }", "{\n  // keep this note\n}", "{\r\n  /* keep this note */\r\n}"]) {
      const code = template.replace("OPTIONS", options)
      const added = edit(file, code, [{ op: "set", key: "kv", value: true }])
      expect(edit(file, added, [{ op: "delete", key: "kv" }])).toBe(code)
    }
  })

  it("replaces a value and quotes keys that are not identifiers", () => {
    expect(edit("vite.config.ts", vite("{ host: \"node\", kv: true }"), [
      { op: "set", key: "host", value: "cloudflare" },
      { op: "set", key: "x-key", value: null },
      { op: "delete", key: "kv" },
    ])).toBe(vite("{ host: \"cloudflare\", \"x-key\": null }"))
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

  it.each([
    'import * as hub from "vite-hub"; export default { plugins: [hub.vitehub({ kv: true })] }',
    'import { vitehub } from "vite-hub"; const config = { plugins: [vitehub({ kv: true })] }; export { config as default }',
  ])("reads and edits namespace imports and named default exports: %s", (code) => {
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true } } } })
    expect(edit("vite.config.ts", code, [{ op: "set", key: "kv", value: false }])).toBe(code.replace("kv: true", "kv: false"))
  })

  it.each([
    'export default { plugins: enabled ? [hub.vitehub({ kv: true })] : [] }',
    'const plugin = hub.vitehub({ kv: true }); export default { plugins: [plugin] }',
  ])("keeps unresolved namespace plugin calls manual: %s", (body) => {
    expect(locateViteHubConfig("vite.config.ts", `import * as hub from "vite-hub"; ${body}`)).toMatchObject({ ok: false, reason: "dynamic-options" })
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

  it.each([
    "enabled ? [vitehub({ kv: true })] : []",
    "enabled && vitehub({ kv: true })",
  ])("keeps conditional plugin calls manual: %s", (plugins) => {
    const code = `import { vitehub } from "vite-hub"; export default { plugins: ${plugins} }`
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: false, reason: "dynamic-options" })
    expect(editViteHubConfig("vite.config.ts", code, [{ op: "set", key: "kv", value: false }]))
      .toMatchObject({ ok: false, reason: "dynamic-options" })
  })

  it.each([
    `modules: [...(enabled ? ["vite-hub/nuxt"] : [])]`,
    `modules: [enabled ? "vite-hub/nuxt" : "other-module"]`,
    `extends: ["./base"]`,
  ])("keeps unresolved Nuxt module registration manual: %s", (options) => {
    expect(locateViteHubConfig("nuxt.config.ts", `export default defineNuxtConfig({ ${options} })`))
      .toMatchObject({ ok: false, reason: "dynamic-options" })
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
    const code = vite("{ ...shared, host: \"node\" }")
    expect(editViteHubConfig("vite.config.ts", code, [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
    expect(editViteHubConfig("vite.config.ts", code, [{ op: "delete", key: "host" }])).toMatchObject({ ok: false, reason: "spread" })
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true, site: { spread: true } })
    expect(edit("vite.config.ts", vite("{ kv: false, ...shared }"), [{ op: "set", key: "kv", value: true }])).toBe(vite("{ ...shared, kv: true }"))
    expect(locateViteHubConfig("vite.config.ts", vite("{ kv: true, ...shared }"))).toMatchObject({ ok: true, site: { keys: { kv: { kind: "expression" } } } })
  })

  it.each([
    ["vite.config.ts", vite("OPTIONS")],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: [[\"vite-hub/nuxt\", OPTIONS]] })\n"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], vitehub: OPTIONS })\n"],
  ])("refuses deleting an explicit key supplied by a spread in %s (%#)", (file, template) => {
    for (const options of ["{ ...shared, kv: false }", "{ kv: false, ...shared }"]) {
      const code = template.replace("OPTIONS", options).replace("export default", "const shared = { kv: true }\nexport default")
      expect(editViteHubConfig(file, code, [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
    }
  })

  it("edits the Nuxt tuple and the vitehub key forms", () => {
    const bare = "import viteHubNuxt from \"vite-hub/nuxt\"\n\nexport default defineNuxtConfig({\n  modules: [viteHubNuxt],\n})\n"
    const tuple = edit("nuxt.config.ts", bare, [{ op: "set", key: "host", value: "node" }])
    expect(tuple).toBe(bare.replace("[viteHubNuxt]", "[[viteHubNuxt, { host: \"node\" }]]"))
    expect(locateViteHubConfig("nuxt.config.ts", tuple)).toMatchObject({ ok: true, site: { form: "nuxt-module-tuple", keys: { host: { kind: "literal", value: "node" } } } })
    expect(edit("nuxt.config.ts", tuple, [{ op: "delete", key: "host" }])).toBe(bare)

    const named = "export default defineNuxtConfig({\n  modules: [\"@nuxt/ui\", [\"vite-hub/nuxt\", { host: \"node\" }]],\n})\n"
    expect(edit("nuxt.config.ts", named, [{ op: "set", key: "kv", value: true }])).toBe(named.replace("{ host: \"node\" }", "{ host: \"node\", kv: true }"))

    const key = "export default defineNuxtConfig({\n  modules: [\"vite-hub/nuxt\"],\n  vitehub: {\n    host: \"node\",\n  },\n})\n"
    expect(locateViteHubConfig("nuxt.config.ts", key)).toMatchObject({ ok: true, site: { form: "nuxt-config-key" } })
    expect(edit("nuxt.config.ts", key, [{ op: "set", key: "kv", value: true }])).toBe(key.replace("    host: \"node\",\n", "    host: \"node\",\n    kv: true,\n"))
    expect(edit("nuxt.config.ts", key, [{ op: "delete", key: "host" }])).toBe(key.replace("{\n    host: \"node\",\n  }", "{}"))

    const both = "export default defineNuxtConfig({\n  modules: [[\"vite-hub/nuxt\", { kv: true }]],\n  vitehub: { host: \"node\" },\n})\n"
    expect(locateViteHubConfig("nuxt.config.ts", both)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true }, host: { kind: "literal", value: "node" } } } })
    expect(edit("nuxt.config.ts", both, [{ op: "set", key: "host", value: "vercel" }])).toBe(both.replace("{ kv: true }", "{ kv: true, host: \"vercel\" }"))
    const overridden = both.replace("{ kv: true }", "{ host: \"vercel\", kv: true }")
    const deleted = edit("nuxt.config.ts", overridden, [{ op: "delete", key: "host" }])
    expect(locateViteHubConfig("nuxt.config.ts", deleted)).toMatchObject({ ok: true, site: { keys: { kv: { kind: "literal", value: true } } } })
    expect(deleted).not.toContain("host")
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

  it.each([
    "modules: [\"vite-hub/nuxt\"], vitehub: { kv: false }, ...base",
    "modules: [\"vite-hub/nuxt\"], ...base, vitehub: { kv: false }",
    "vitehub: { kv: false }, ...base, modules: [\"vite-hub/nuxt\"]",
    "modules: [[\"vite-hub/nuxt\", { kv: false }]], ...base",
    "modules: [\"vite-hub/nuxt\"], ...base",
  ])("refuses a Nuxt root spread that can override the selected config (%#)", (properties) => {
    const code = `const base = { modules: [], vitehub: { kv: true } }\nexport default defineNuxtConfig({ ${properties} })\n`
    expect(locateViteHubConfig("nuxt.config.ts", code)).toMatchObject({ ok: false, reason: "spread", line: 2 })
    expect(editViteHubConfig("nuxt.config.ts", code, [{ op: "set", key: "kv", value: true }])).toMatchObject({ ok: false, reason: "spread" })
    expect(editViteHubConfig("nuxt.config.ts", code, [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
  })

  it("edits top-level Nuxt options that follow the root spread", () => {
    const code = 'export default defineNuxtConfig({ ...base, modules: ["vite-hub/nuxt"], vitehub: { kv: false } })\n'
    expect(locateViteHubConfig("nuxt.config.ts", code)).toMatchObject({ ok: true })
    const added = edit("nuxt.config.ts", code, [{ op: "set", key: "host", value: "node" }])
    expect(added).toBe(code.replace("kv: false", "kv: false, host: \"node\""))
    expect(edit("nuxt.config.ts", added, [{ op: "delete", key: "host" }])).toBe(code)
  })

  it.each([
    "[\"vite-hub/nuxt\", { kv: false }]",
    "\"vite-hub/nuxt\"",
  ])("refuses a tuple deletion when a leading root spread can supply options (%#)", (entry) => {
    const code = `const base = { vitehub: { kv: true } }\nexport default defineNuxtConfig({ ...base, modules: [${entry}] })\n`
    expect(locateViteHubConfig("nuxt.config.ts", code)).toMatchObject({ ok: false, reason: "spread" })
    expect(editViteHubConfig("nuxt.config.ts", code, [{ op: "delete", key: "kv" }])).toMatchObject({ ok: false, reason: "spread" })
    expect(editViteHubConfig("nuxt.config.ts", code, [{ op: "set", key: "kv", value: false }])).toMatchObject({ ok: false, reason: "spread" })
  })

  it("does not evaluate code", () => {
    const sentinel: { __evaluated?: boolean } = globalThis
    const code = "import { vitehub } from \"vite-hub\"\nglobalThis.__evaluated = true\nexport default { plugins: [vitehub({ kv: (globalThis.__evaluated = true) })] }\n"
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true })
    expect(edit("vite.config.ts", code, [{ op: "set", key: "blob", value: true }])).toContain("blob: true")
    expect(sentinel.__evaluated).toBeUndefined()
  })
})

describe("insertViteHubConfig", () => {
  it.each(["hub.default", 'hub["default"]'])("preserves Nuxt namespace registrations through %s", (member) => {
    for (const entry of [member, `[${member}, { host: "node" }]`]) {
      const code = `import * as hub from "vite-hub/nuxt"\nexport default { modules: [${entry}] }\n`
      expect(insertViteHubConfig("nuxt.config.ts", code, { host: "deno" })).toEqual({ ok: true, code })
      const edited = edit("nuxt.config.ts", code, [{ op: "set", key: "host", value: "deno" }])
      expect(edited).toContain(`modules: [[${member}, { host: "deno" }]]`)
      expect(locateViteHubConfig("nuxt.config.ts", edited)).toMatchObject({ ok: true, site: { keys: { host: { value: "deno" } } } })
    }
  })

  it.each(["hub.vitehub", 'hub["vitehub"]'])("preserves an existing namespace registration through %s", (callee) => {
    const code = `import * as hub from "vite-hub"\nexport default { plugins: [${callee}({ host: "node" })] }\n`
    expect(insertViteHubConfig("vite.config.ts", code, { host: "deno" })).toEqual({ ok: true, code })
    expect(locateViteHubConfig("vite.config.ts", code)).toMatchObject({ ok: true, site: { keys: { host: { value: "node" } } } })
    expect(edit("vite.config.ts", code, [{ op: "set", key: "host", value: "deno" }])).toBe(code.replace('host: "node"', 'host: "deno"'))
    const factored = `import * as hub from "vite-hub"\nconst plugins = [${callee}({ host: "node" })]\nexport default { plugins }\n`
    expect(insertViteHubConfig("vite.config.ts", factored, { host: "deno" })).toMatchObject({ ok: false, reason: "dynamic-options" })
  })

  it("adds vitehub() and its import to the Vite plugins", () => {
    const code = "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({\n  plugins: [\n    vue(),\n  ],\n})\n"
    expect(insertViteHubConfig("vite.config.ts", code, { host: "cloudflare" })).toEqual({
      code: "import vue from '@vitejs/plugin-vue'\nimport { defineConfig } from 'vite'\nimport { vitehub } from 'vite-hub'\n\nexport default defineConfig({\n  plugins: [\n    vue(),\n    vitehub({ host: 'cloudflare' }),\n  ],\n})\n",
      ok: true,
    })
  })

  it("adds a plugins key when the config has none", () => {
    const code = "import { defineConfig } from \"vite\"\n\nexport default defineConfig({\n  server: { port: 3000 },\n})\n"
    const result = insertViteHubConfig("vite.config.ts", code, { host: "node" })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.code).toBe("import { defineConfig } from \"vite\"\nimport { vitehub } from \"vite-hub\"\n\nexport default defineConfig({\n  server: { port: 3000 },\n  plugins: [vitehub({ host: \"node\" })],\n})\n")
  })

  it("adds the module tuple to the Nuxt modules", () => {
    const code = "// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: true },\n  modules: [],\n})\n"
    const result = insertViteHubConfig("nuxt.config.ts", code, { host: "vercel" })
    expect(result.ok && result.code).toBe("import viteHubNuxt from 'vite-hub/nuxt'\n\n// https://nuxt.com/docs/api/configuration/nuxt-config\nexport default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n  devtools: { enabled: true },\n  modules: [[viteHubNuxt, { host: 'vercel' }]],\n})\n")
    expect(result.ok && locateViteHubConfig("nuxt.config.ts", result.code)).toMatchObject({ ok: true, site: { form: "nuxt-module-tuple", keys: { host: { kind: "literal", value: "vercel" } } } })
  })

  it.each([
    ["vite.config.ts", "plugins"],
    ["nuxt.config.ts", "modules"],
  ])("refuses a %s registration that a later member can override", (file, key) => {
    for (const member of ["...shared", `${key}() { return [] }`, `get ${key}() { return [] }`, "[key]: []"]) {
      const code = `export default { ${key}: [], ${member} }\n`
      expect(insertViteHubConfig(file, code, { host: "node" })).toMatchObject({ ok: false })
    }
  })

  it("keeps a Vite plugins array that overrides an earlier spread", () => {
    const code = "export default { ...shared, plugins: [] }\n"
    const result = insertViteHubConfig("vite.config.ts", code, { host: "node" })
    expect(result.ok && result.code).toContain('...shared, plugins: [vitehub({ host: "node" })]')
  })

  it("keeps a config that registers ViteHub, and leaves a function config manual", () => {
    const registered = "import { vitehub } from \"vite-hub\"\nexport default { plugins: [vitehub({ host: \"node\" })] }\n"
    expect(insertViteHubConfig("vite.config.ts", registered, { host: "deno" })).toEqual({ code: registered, ok: true })
    expect(insertViteHubConfig("vite.config.ts", "export default defineConfig(() => ({ plugins: [] }))\n", { host: "node" })).toMatchObject({ ok: false, reason: "dynamic-options" })
    expect(insertViteHubConfig("vite.config.ts", "export default { plugins: shared }\n", { host: "node" })).toMatchObject({ ok: false, reason: "dynamic-options" })
  })
})
