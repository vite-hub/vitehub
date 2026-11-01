import { describe, expect, it, vi } from "vitest"
import { runProjectFixture } from "vite-doctor/testkit"
import type { PluginOption } from "vite"
import type { DoctorPluginApi } from "vite-doctor/extension"

import vitehubDoctorExtension, { destructureResultTuples, noInternalImports, noServerImportsInClient } from "../src/doctor.ts"
import { vitehub } from "../src/index.ts"
import { codes, doctorTestTimeout } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

function doctorPluginApi(plugins: PluginOption[]): DoctorPluginApi | undefined {
  for (const plugin of plugins) {
    const api = Array.isArray(plugin)
      ? doctorPluginApi(plugin)
      : plugin && "api" in plugin && plugin.name === "vite-hub/doctor" ? plugin.api?.doctor : undefined
    if (api) return api
  }
}

describe("vitehub/no-internal-imports", () => {
  it("reports internal and generated imports", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        "import { kv } from \"vite-hub/_internal/kv\"",
        "import { isPlainObject } from \"@vite-hub/internal/object\"",
        "import state from \"@vite-hub/queue/internal/runtime/state\"",
        "export * from \"@vite-hub/sandbox/_internal/task/runtime\"",
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

describe("vitehub/no-internal-imports generated aliases", () => {
  it("reports private #vitehub aliases and Nuxt generated files", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        'import { registry } from "#vitehub/agent/registry"',
        'import config from "#vitehub/kv/config"',
        'import wrapper from "../../.nuxt/vitehub/agent/netlify-function.mjs"',
        "export { registry, config, wrapper }",
      ].join("\n"),
    })).toEqual(["VHUB0001", "VHUB0001", "VHUB0001"])
  })

  it("accepts generated declarations loaded from a declaration file", async () => {
    expect(await codes(noInternalImports, {
      "env.d.ts": 'import "./.vitehub/queue.d.ts"\n',
    })).toEqual([])
  })

  it("accepts the documented #vitehub aliases", async () => {
    expect(await codes(noInternalImports, {
      "server/api/a.ts": [
        'import { usePublicEnv } from "#vitehub/env/public"',
        'import { useServerEnv } from "#vitehub/env/server"',
        'import auth from "#vitehub/auth/server"',
        'import welcome from "#vitehub/emails/welcome"',
        'import { schedules } from "#vitehub/schedule/registry"',
        "export { usePublicEnv, useServerEnv, auth, welcome, schedules }",
      ].join("\n"),
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

  it("reports server-only package roots without a server segment", async () => {
    expect(await codes(noServerImportsInClient, {
      "app/pages/index.vue": [
        "<script setup lang=\"ts\">",
        'import { kv } from "vite-hub/kv"',
        'import { runAgent } from "vite-hub/agent"',
        'import { runQueue } from "@vite-hub/queue"',
        'import { runSandboxTask } from "vite-hub/sandbox/task"',
        "</script>",
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0002", "VHUB0002", "VHUB0002", "VHUB0002"])
  })

  it("accepts browser entries of server primitives", async () => {
    expect(await codes(noServerImportsInClient, {
      "app/pages/index.vue": [
        "<script setup lang=\"ts\">",
        'import { useAgent } from "vite-hub/agent/vue"',
        'import { useUpload } from "vite-hub/blob/vue"',
        'import { useRealtimeTiptap } from "vite-hub/realtime/vue"',
        'import { defineSchedule } from "vite-hub/schedule"',
        "</script>",
      ].join("\n"),
    }, "nuxt")).toEqual([])
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

describe("vitehub/destructure-result-tuples", () => {
  it("reports KV and Blob results used as values", async () => {
    expect(await codes(destructureResultTuples, {
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
    expect(await codes(destructureResultTuples, {
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
    expect(await codes(destructureResultTuples, {
      "server/api/scopes.ts": source,
    }, "nuxt")).toEqual([])
    expect(await codes(destructureResultTuples, {
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
    expect(await codes(destructureResultTuples, {
      "server/api/modules.ts": [
        source,
        'namespace Sibling { async function read() { const siblingKv = await kv.get("sibling"); const siblingBlob = await blob.get("sibling") } }',
        'const a = await kv.get("x")',
        'const b = await blob.get("x")',
      ].join("\n"),
    }, "nuxt")).toEqual(Array(4).fill("VHUB0003"))
  })

  it.each(["kv", "blob"])("binds runtime namespace %s only in its enclosing scope", async (name) => {
    expect(await codes(destructureResultTuples, {
      "server/api/namespaces.ts": [
        `namespace Local { namespace ${name} { export const x = 1 }; async function read() { const result = await ${name}.get("x") } }`,
        `namespace Sibling { async function read() { const siblingResult = await ${name}.get("sibling") } }`,
        `const outerResult = await ${name}.get("outer")`,
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0003", "VHUB0003"])
    expect(await codes(destructureResultTuples, {
      "server/api/namespaces.ts": `namespace ${name} { export const x = 1 }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual([])
  })

  it.each(["kv", "blob"])("preserves auto-imports across erased %s namespaces", async (name) => {
    for (const body of ["", "export interface X {}", "export type X = string", "interface X {} export { type X }", "export namespace Types { export interface X {} }", "export namespace Types.Deep { export type X = string }"]) {
      expect(await codes(destructureResultTuples, {
        "server/api/erased.ts": `namespace ${name} { ${body} }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual(["VHUB0003"])
    }
    expect(await codes(destructureResultTuples, {
      "server/api/merged-types.ts": `namespace ${name} { export interface X {} }; namespace ${name} { export type Y = string }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it.each(["kv", "blob"])("distinguishes erased and exported namespace aliases for %s", async (name) => {
    for (const exported of [false, true]) {
      expect(await codes(destructureResultTuples, {
        "server/api/aliases.ts": `namespace Types { export const x = 1 }; namespace ${name} { ${exported ? "export " : ""}import X = Types }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual(exported ? [] : ["VHUB0003"])
    }
  })

  it.each(["kv", "blob"])("retains runtime bindings for nested and merged %s namespaces", async (name) => {
    for (const body of ["export namespace Values { export const x = 1 }", "export namespace Values.Deep { export const x = 1 }"]) {
      expect(await codes(destructureResultTuples, {
        "server/api/nested.ts": `namespace ${name} { ${body} }; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual([])
    }
    expect(await codes(destructureResultTuples, {
      "server/api/qualified.ts": `namespace ${name}.Values { export const x = 1 }; const result = await ${name}.get("x")`,
    }, "nuxt")).toEqual([])
    for (const bodies of [["export interface X {}", "export const x = 1"], ["export const x = 1", "export interface X {}"]]) {
      expect(await codes(destructureResultTuples, {
        "server/api/merged.ts": `${bodies.map(body => `namespace ${name} { ${body} }`).join("; ")}; const result = await ${name}.get("x")`,
      }, "nuxt")).toEqual([])
    }
  })

  it.each([
    'declare namespace kv { const x: number }',
    'declare module "kv" { const x: number }',
    'declare namespace Local { namespace kv { const x: number }; const result: typeof kv };',
  ])("does not bind ambient modules as runtime helpers: %s", async (source) => {
    expect(await codes(destructureResultTuples, {
      "server/api/ambient.ts": `${source}\nconst result = await kv.get("x")`,
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it("resolves local helpers and stores within namespaces", async () => {
    expect(await codes(destructureResultTuples, {
      "server/api/modules.ts": [
        'import { kv as cache } from "vite-hub/kv"',
        'namespace Local { const kv = local; async function read() { const a = await kv.get("x") } }',
        'namespace Stores { const store = cache.store("cache"); async function read() { const a = await store.get("x") } }',
        'namespace Sibling { async function read() { const a = await store.get("x") } }',
      ].join("\n"),
    }, "nuxt")).toEqual(["VHUB0003"])
  })

  it("resolves imported helpers and store handles by binding, not by name", async () => {
    expect(await codes(destructureResultTuples, {
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
    expect(await codes(destructureResultTuples, {
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
    expect(await codes(destructureResultTuples, {
      "server/api/settings.get.ts": "import { kv } from \"./local-kv.ts\"\nexport default async () => {\n  const settings = await kv.get(\"settings\")\n  return settings\n}\n",
      "server/api/local-kv.ts": "export const kv = new Map<string, string>()\n",
      "server/api/local-blob.get.ts": "const blob = new Map<string, string>()\nexport default async () => {\n  const value = await blob.get(\"a\")\n  return value\n}\n",
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/destructure-result-tuples beyond KV and Blob", () => {
  it("reports other Runtime Helpers that return tuples", async () => {
    expect(await codes(destructureResultTuples, {
      "server/api/send.post.ts": [
        'import { blob } from "vite-hub/blob"',
        'import { email } from "vite-hub/email/server"',
        'import { runQueue, getQueue } from "vite-hub/queue"',
        'import { useChannel } from "vite-hub/channels/server"',
        'import { callMcpTool } from "vite-hub/agent/mcp"',
        'import { runAgent } from "vite-hub/agent"',
        "import support from \"../agents/support\"",
        "export async function send() {",
        '  const record = await blob.media.put("a.png", body)',
        '  const sent = await email.send({ to: "a@b.c" })',
        '  if (await runQueue("welcome", {})) return',
        '  const delivery = await useChannel("alerts").send("hi", {})',
        '  const queue = await getQueue("welcome")',
        "  const receipt = await queue.send({})",
        '  const tool = await callMcpTool({ connection: "crm" }, "search", {})',
        '  const answer = await runAgent(support, { prompt: "hi" })',
        "  return { record, sent, delivery, receipt, tool, answer }",
        "}",
      ].join("\n"),
    })).toEqual(Array(7).fill("VHUB0003"))
  })

  it("reports tuples compared, iterated, interpolated, or returned from a route handler", async () => {
    expect(await codes(destructureResultTuples, {
      "server/api/files/[...path].get.ts": [
        'import { kv } from "vite-hub/kv"',
        'import { blob } from "vite-hub/blob"',
        "export default defineEventHandler(async (event) => {",
        '  if ((await kv.get("a")) === null) return',
        '  for (const key of await kv.keys()) console.log(key)',
        '  console.log(`${await kv.get("b")}`)',
        '  return blob.serve(event, "a.txt")',
        "})",
      ].join("\n"),
    })).toEqual(Array(4).fill("VHUB0003"))
  })

  it("accepts runAgent with a Runtime Context, error-only patterns, and tuples passed on from helpers", async () => {
    expect(await codes(destructureResultTuples, {
      "server/utils/settings.ts": [
        'import { kv } from "vite-hub/kv"',
        'import { runAgent } from "vite-hub/agent"',
        "export async function clear() {",
        '  const [error] = await kv.del("settings")',
        "  if (error) throw error",
        "}",
        "export async function readSettings() {",
        '  return await kv.get("settings")',
        "}",
        "export async function ask(agent, ctx) {",
        '  const answer = await runAgent(agent, ctx, { prompt: "hi" })',
        "  return answer",
        "}",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("ViteHub Project Inventory", () => {
  it("lists Definitions with the discovery of each owner package", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { viteHubInventoryContributor } = await import("../src/doctor/inventory.ts")
    const root = await mkdtemp(join(tmpdir(), "vitehub-doctor-inventory-"))
    try {
      const files: Record<string, string> = {
        "server/queues/welcome-email.ts": "export default 1\n",
        "server/workflows/onboard.ts": "export default 1\n",
        "server/agents/support.ts": "export default 1\n",
        "layers/base/server/queues/digest.ts": "export default 1\n",
        ".vitehub/env/description.mjs": `export function describeServerEnv() { return JSON.parse(${JSON.stringify(JSON.stringify({ entries: [
          { path: "env.server.github.token", source: "env", secret: true, required: true, hasDefault: false },
          { path: "env.server.dryRun", source: "env", secret: false, required: false, hasDefault: true },
          { path: "env.server.crm", source: "provider", secret: true, required: true, hasDefault: false },
        ] }))}); }\n`,
      }
      for (const [file, text] of Object.entries(files)) {
        await mkdir(join(root, file, ".."), { recursive: true })
        await writeFile(join(root, file), text)
      }
      const inventory = await viteHubInventoryContributor.contribute({ root, framework: "vite", ssr: false, vueVersion: "", isMonorepo: false })
      expect(inventory).toMatchObject({
        definitions: {
          queue: expect.arrayContaining([{ name: "welcome-email", file: "server/queues/welcome-email.ts" }, { name: "digest", file: "layers/base/server/queues/digest.ts" }]),
          workflow: expect.arrayContaining([{ name: "onboard", file: "server/workflows/onboard.ts" }]),
          agent: [{ name: "support", file: "server/agents/support.ts" }],
        },
        env: { secret: ["github.token", "crm"], provider: ["crm"] },
      })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
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
