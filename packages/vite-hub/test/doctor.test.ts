import { describe, expect, it } from "vitest"
import { runProjectFixture, runRuleFixture } from "vite-doctor/testkit"
import type { PluginOption } from "vite"
import type { DoctorPluginApi, DoctorRule } from "vite-doctor/extension"

import vitehubDoctorExtension, { destructureStorageResults, noInternalImports, noServerImportsInClient } from "../src/doctor.ts"
import { vitehub } from "../src/index.ts"

function doctorPluginApi(plugins: PluginOption[]): DoctorPluginApi | undefined {
  for (const plugin of plugins) {
    const api = Array.isArray(plugin)
      ? doctorPluginApi(plugin)
      : plugin && "api" in plugin && plugin.name === "vite-hub/doctor" ? plugin.api?.doctor : undefined
    if (api) return api
  }
}

async function codes(rule: DoctorRule, files: Record<string, string>, framework: "nuxt" | "vite" = "vite") {
  const result = await runRuleFixture({ rule, framework, files })
  return result.diagnostics.map(diagnostic => diagnostic.code)
}

describe("vitehub/no-internal-imports", () => {
  it("reports internal and generated imports", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        "import { kv } from \"vite-hub/_internal/kv\"",
        "import { isPlainObject } from \"@vite-hub/internal/object\"",
        "import state from \"@vite-hub/queue/internal/runtime/state\"",
        "export * from \"@vite-hub/sandbox/_internal/runtime\"",
        "const env = await import(\"../../.vitehub/env/server.ts\")",
        "export { kv, isPlainObject, state, env }",
      ].join("\n"),
    })).toEqual(["VHUB0001", "VHUB0001", "VHUB0001", "VHUB0001", "VHUB0001"])
  })

  it("accepts public paths and generated aliases", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { useServerEnv } from \"#vitehub/env/server\"",
        "import { defineQueue } from \"@vite-hub/queue\"",
        "import internal from \"./internal/helper.ts\"",
        "export { kv, useServerEnv, defineQueue, internal }",
      ].join("\n"),
      "server/api/internal/helper.ts": "export default 1\n",
      ".vitehub/agent/registry.ts": "export { agent } from \"vite-hub/_internal/agent\"\n",
    })).toEqual([])
  })
})

describe("vitehub/no-server-imports-in-client", () => {
  it("reports server-only imports in Vue components and Nuxt app code", async () => {
    expect(await codes(noServerImportsInClient, {
      "src/App.vue": "<script setup lang=\"ts\">\nimport { useServerEnv } from \"#vitehub/env/server\"\nconst env = useServerEnv()\n</script>\n<template><div>{{ env }}</div></template>\n",
    })).toEqual(["VHUB0002"])
    expect(await codes(noServerImportsInClient, {
      "app/composables/useMail.ts": "import { email } from \"vite-hub/email/server\"\nexport const useMail = () => email\n",
      "app/pages/index.vue": "<script setup lang=\"ts\">\nimport { useDatabase } from \"vite-hub/database/drizzle\"\nconst db = useDatabase()\n</script>\n<template><div>{{ db }}</div></template>\n",
    }, "nuxt")).toEqual(["VHUB0002", "VHUB0002"])
  })

  it("checks the generated auth server alias in client files", async () => {
    expect(await codes(noServerImportsInClient, {
      "src/App.vue": '<script setup>import auth from "#vitehub/auth/server"</script>',
      "server/api/auth.ts": 'export { default } from "#vitehub/auth/server"',
    })).toEqual(["VHUB0002"])
  })

  it("accepts inline type specifiers but reports mixed and side-effect declarations", async () => {
    expect(await codes(noServerImportsInClient, {
      "app/utils/types.ts": [
        'import { type Email } from "vite-hub/email/server"',
        'export { type Email as Mail } from "vite-hub/email/server"',
        'export type * from "vite-hub/email/server"',
      ].join("\n"),
    }, "nuxt")).toEqual([])
    for (const source of [
      'import { type Email, email } from "vite-hub/email/server"',
      'export { type Email, email } from "vite-hub/email/server"',
      'import "vite-hub/email/server"',
      'export * from "vite-hub/email/server"',
    ]) {
      expect(await codes(noServerImportsInClient, { "app/utils/mail.ts": source }, "nuxt")).toEqual(["VHUB0002"])
    }
  })

  it("accepts server files, type imports, and client paths", async () => {
    expect(await codes(noServerImportsInClient, {
      "server/api/env.get.ts": "import { useServerEnv } from \"#vitehub/env/server\"\nexport default () => useServerEnv()\n",
      "src/App.vue": "<script setup lang=\"ts\">\nimport type { Email } from \"vite-hub/email/server\"\nimport { useUpload } from \"vite-hub/blob/vue\"\nimport { usePublicEnv } from \"#vitehub/env/public\"\ndefineProps<{ email?: Email }>()\nconst upload = useUpload()\nconst env = usePublicEnv()\n</script>\n<template><div>{{ upload }} {{ env }}</div></template>\n",
    })).toEqual([])
    expect(await codes(noServerImportsInClient, {
      "app/plugins/env.server.ts": "import { useServerEnv } from \"#vitehub/env/server\"\nexport default () => useServerEnv()\n",
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/destructure-storage-results", () => {
  it("reports KV and Blob results used as values", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { blob as files } from \"@vite-hub/blob\"",
        "const reports = files.store(\"reports\")",
        "export default async () => {",
        "  const settings = await kv.get(\"settings\")",
        "  if (await kv.has(\"flag\")) return settings",
        "  const size = (await reports.head(\"a.txt\")).size",
        "  return !(await kv.store(\"cache\").has(\"key\")) && size",
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0003", "VHUB0003", "VHUB0003", "VHUB0003"])
  })

  it("reports auto-imported helpers in Nuxt server files", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": "export default async () => {\n  const settings = await kv.get(\"settings\")\n  return settings\n}\n",
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it.each([
    'async function parameter(kv) { const value = await kv.get("x") }',
    'const arrow = async ({ kv }, ...blob) => { const value = await kv.get("x"); const other = await blob.get("x") }',
    'async function caught() { try {} catch (kv) { const value = await kv.get("x") } }',
    'async function destructured() { const { nested: { kv }, blob = {} } = local; const value = await kv.get("x"); const other = await blob.get("x") }',
    'async function array() { const [kv] = local; const value = await kv.get("x") }',
    'async function hoisted() { const value = await kv.get("x"); if (true) { var kv = local } }',
    'async function declared() { const value = await kv.get("x"); function kv() {} }',
    'async function classBinding() { class kv {}; const value = await kv.get("x") }',
    'async function later() { const value = await kv.get("x"); const kv = local }',
    'async function loop() { for (const kv of locals) { const value = await kv.get("x") } }',
  ])("limits Nuxt auto-import shadowing to the binding's scope: %s", async (source) => {
    expect(await codes(destructureStorageResults, {
      "server/api/scopes.ts": source,
    }, "nuxt")).toEqual([])
    expect(await codes(destructureStorageResults, {
      "server/api/scopes.ts": [
        source,
        'async function sibling() { const siblingResult = await kv.get("x") }',
        'const outerResult = await blob.get("x")',
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0003", "VHUB0003"])
  })

  it.each([
    'namespace Local { const kv = local; const blob = local }',
    'namespace Local { var kv = local; var blob = local }',
    'namespace Local.Nested { const kv = local; const blob = local }',
    'declare module "local-storage" { const kv: unknown; const blob: unknown }',
  ])("keeps TypeScript module bindings inside their bodies: %s", async (source) => {
    expect(await codes(destructureStorageResults, {
      "server/api/modules.ts": [
        source,
        'namespace Sibling { async function read() { const siblingKv = await kv.get("sibling"); const siblingBlob = await blob.get("sibling") } }',
        'const a = await kv.get("x")',
        'const b = await blob.get("x")',
      ].join("\n"),
    }, "nuxt")).toEqual(Array(4).fill("VHUB0003"))
  })

  it.each(["kv", "blob"])("binds runtime namespace %s only in its enclosing scope", async (name) => {
    expect(await codes(destructureStorageResults, {
      "server/api/namespaces.ts": [
        `namespace Local { namespace ${name} { export const x = 1 }; async function read() { const result = await ${name}.get("x") } }`,
        `namespace Sibling { async function read() { const siblingResult = await ${name}.get("sibling") } }`,
        `const outerResult = await ${name}.get("outer")`,
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0003", "VHUB0003"])
    expect(await codes(destructureStorageResults, {
      "server/api/namespaces.ts": `namespace ${name} { export const x = 1 }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual([])
  })

  it.each(["kv", "blob"])("preserves auto-imports across erased %s namespaces", async (name) => {
    for (const body of ["", "export interface X {}", "export type X = string", "interface X {} export { type X }", "export namespace Types { export interface X {} }", "export namespace Types.Deep { export type X = string }"]) {
      expect(await codes(destructureStorageResults, {
        "server/api/erased.ts": `namespace ${name} { ${body} }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual(["VHUB0003"])
    }
    expect(await codes(destructureStorageResults, {
      "server/api/merged-types.ts": `namespace ${name} { export interface X {} }; namespace ${name} { export type Y = string }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it.each(["kv", "blob"])("distinguishes erased and exported namespace aliases for %s", async (name) => {
    for (const exported of [false, true]) {
      expect(await codes(destructureStorageResults, {
        "server/api/aliases.ts": `namespace Types { export const x = 1 }; namespace ${name} { ${exported ? "export " : ""}import X = Types }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual(exported ? [] : ["VHUB0003"])
    }
  })

  it.each(["kv", "blob"])("retains runtime bindings for nested and merged %s namespaces", async (name) => {
    for (const body of ["export namespace Values { export const x = 1 }", "export namespace Values.Deep { export const x = 1 }"]) {
      expect(await codes(destructureStorageResults, {
        "server/api/nested.ts": `namespace ${name} { ${body} }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual([])
    }
    expect(await codes(destructureStorageResults, {
      "server/api/qualified.ts": `namespace ${name}.Values { export const x = 1 }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual([])
    for (const bodies of [["export interface X {}", "export const x = 1"], ["export const x = 1", "export interface X {}"]]) {
      expect(await codes(destructureStorageResults, {
        "server/api/merged.ts": `${bodies.map(body => `namespace ${name} { ${body} }`).join("; ")}; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual([])
    }
  })

  it.each([
    'declare namespace kv { const x: number }',
    'declare module "kv" { const x: number }',
    'declare namespace Local { namespace kv { const x: number }; const result: typeof kv };',
  ])("does not bind ambient modules as runtime helpers: %s", async (source) => {
    expect(await codes(destructureStorageResults, {
      "server/api/ambient.ts": `${source}\nconst result = await kv.get("x")`,
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it("resolves local helpers and stores within namespaces", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/modules.ts": [
        'import { kv as cache } from "vite-hub/kv"',
        'namespace Local { const kv = local; async function read() { const a = await kv.get("x") } }',
        'namespace Stores { const store = cache.store("cache"); async function read() { const a = await store.get("x") } }',
        'namespace Sibling { async function read() { const a = await store.get("x") } }',
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it("resolves imported helpers and store handles by binding, not by name", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/imports.ts": [
        'import { kv as cache } from "vite-hub/kv"',
        'const store = cache.store("cache")',
        'async function shadow(cache, store) { const a = await cache.get("x"); const b = await store.get("x") }',
        'async function local() { const cache = localCache; const store = cache.store("local"); const value = await store.get("x") }',
        'async function nested() { const inner = store.store("nested"); const nestedResult = await inner.get("x") }',
        'async function scoped() { const scopedStore = cache.store("scoped"); const scopedResult = await scopedStore.get("x") }',
        'async function unrelated(scopedStore) { const value = await scopedStore.get("x") }',
        'const a = await cache.get("x")',
        'const b = await store.get("x")',
      ].join("\n"),
    })).toEqual(Array(4).fill("VHUB0003"))
  })

  it("accepts destructured, indexed, ignored, and unrelated results", async () => {
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": [
        "import { kv } from \"vite-hub/kv\"",
        "import { blob } from \"vite-hub/blob\"",
        "export default async () => {",
        "  const [error, settings] = await kv.get(\"settings\")",
        "  if (error) throw error",
        "  await kv.set(\"seen\", true)",
        "  const missing = (await blob.head(\"a.txt\"))[0]",
        "  return { settings, missing }",
        "}",
      ].join("\n"),
      "server/api/other.get.ts": "const kv = new Map<string, string>()\nexport default async () => {\n  const value = await kv.get(\"a\")\n  return value\n}\n",
    })).toEqual([])
    expect(await codes(destructureStorageResults, {
      "server/api/settings.get.ts": "import { kv } from \"./local-kv.ts\"\nexport default async () => {\n  const settings = await kv.get(\"settings\")\n  return settings\n}\n",
      "server/api/local-kv.ts": "export const kv = new Map<string, string>()\n",
      "server/api/local-blob.get.ts": "const blob = new Map<string, string>()\nexport default async () => {\n  const value = await blob.get(\"a\")\n  return value\n}\n",
    }, "nuxt")).toEqual([])
  })
})

describe("ViteHub Doctor Extension", () => {
  it("links each diagnostic to its documentation", async () => {
    const result = await runProjectFixture({
      framework: "vite",
      extensions: [vitehubDoctorExtension],
      dependencies: { "vite-hub": "*" },
      files: {
        "src/App.vue": "<script setup lang=\"ts\">\nimport { useServerEnv } from \"vite-hub/env/server\"\nconst env = useServerEnv()\n</script>\n<template><div>{{ env }}</div></template>\n",
        "server/api/a.ts": "import { kv } from \"vite-hub/_internal/kv\"\nexport default async () => (await kv.get(\"a\")).value\n",
      },
    })
    const found = result.diagnostics
      .filter(diagnostic => diagnostic.code.startsWith("VHUB"))
      .map(diagnostic => [diagnostic.code, diagnostic.docs])
      .sort()
    expect(found).toEqual([
      ["VHUB0001", "https://vitehub.dev/docs/reference/doctor-rules#vhub0001"],
      ["VHUB0002", "https://vitehub.dev/docs/reference/doctor-rules#vhub0002"],
    ])
  })

  it("is exposed by the Vite plugin as a lazy Doctor Extension", async () => {
    const api = doctorPluginApi(vitehub({ preset: "node" }))
    expect(api?.extensions).toHaveLength(1)
    const [load] = api?.extensions ?? []
    if (typeof load !== "function") throw new TypeError("Expected a lazy Doctor Extension loader.")
    const loaded = await load()
    expect("default" in loaded ? loaded.default : loaded).toBe(vitehubDoctorExtension)
  })
})
