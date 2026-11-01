import { describe, expect, it, vi } from "vitest"

import {
  commentsEntry,
  defineAgentFromViteHub,
  forgeErrorImports,
  markdownFilePath,
  noNuxtHubLeftovers,
  noRemovedApis,
  noViteHubPluginInNuxt,
  rateLimitCapabilityLimiter,
  realtimeCarets,
  realtimePersistence,
  sandboxRuntimeOptions,
  validViteHubOptions,
} from "../src/doctor/rules/integrations.ts"
import { codes, doctorTestTimeout } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

const lines = (...source: string[]) => `${source.join("\n")}\n`
const manifest = (dependencies: Record<string, string>) => JSON.stringify({ type: "module", dependencies: { vite: "^8.0.0", ...dependencies } })

describe("vitehub/realtime-carets", () => {
  it("reports CollaborationCaret next to Realtime", async () => {
    expect(await codes(realtimeCarets, {
      "src/Editor.vue": lines(
        "<script setup lang=\"ts\">",
        "import { useRealtimeTiptap } from \"vite-hub/realtime/vue\"",
        "import CollaborationCaret from \"@tiptap/extension-collaboration-caret\"",
        "const realtime = useRealtimeTiptap(\"notes\", \"a\")",
        "</script>",
      ),
    })).toEqual(["VHUB0024"])
  })

  it("accepts the carets option and apps without Realtime", async () => {
    expect(await codes(realtimeCarets, {
      "src/Editor.vue": lines(
        "<script setup lang=\"ts\">",
        "import { useRealtimeTiptap } from \"vite-hub/realtime/vue\"",
        "const realtime = useRealtimeTiptap(\"notes\", \"a\", { carets: { render: () => document.createElement(\"span\") } })",
        "</script>",
      ),
      "src/Other.vue": "<script setup lang=\"ts\">\nimport CollaborationCaret from \"@tiptap/extension-collaboration-caret\"\n</script>\n",
    })).toEqual([])
  })
})

describe("vitehub/realtime-persistence", () => {
  it("reports maxWait below debounce, including defaults, and values that are not milliseconds", async () => {
    expect(await codes(realtimePersistence, {
      "server/realtime/notes.ts": lines(
        "import { defineRealtime } from \"vite-hub/realtime\"",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: { debounce: 5000, maxWait: 1000 } })",
      ),
      "server/realtime/slow.ts": lines(
        "import { defineRealtime } from \"@vite-hub/realtime\"",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: { debounce: 20000 } })",
      ),
      "server/realtime/text.ts": lines(
        "import { defineRealtime } from \"vite-hub/realtime\"",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: { debounce: \"2s\" } })",
      ),
    })).toEqual(["VHUB0025", "VHUB0025", "VHUB0025"])
  })

  it("accepts valid and dynamic timings", async () => {
    expect(await codes(realtimePersistence, {
      "server/realtime/notes.ts": lines(
        "import { defineRealtime } from \"vite-hub/realtime\"",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: { debounce: 500, maxWait: 5000 } })",
      ),
      "server/realtime/dynamic.ts": lines(
        "import { defineRealtime } from \"vite-hub/realtime\"",
        "const debounce = Number(\"9000\")",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: { debounce, maxWait: 1000 } })",
      ),
      "server/realtime/off.ts": lines(
        "import { defineRealtime } from \"vite-hub/realtime\"",
        "export default defineRealtime({ document: { workspace: \"docs\" }, persistence: false })",
      ),
    })).toEqual([])
  })
})

describe("vitehub/forge-error-imports", () => {
  it("reports Forge error classes from forges", async () => {
    expect(await codes(forgeErrorImports, {
      "package.json": manifest({ "@vite-hub/forge": "*", "forges": "*" }),
      "server/utils/pr.ts": lines(
        "import { NotFoundError, repoRef } from \"forges\"",
        "export const missing = (error: unknown) => error instanceof NotFoundError && repoRef",
      ),
    })).toEqual(["VHUB0026"])
  })

  it("accepts imports from @vite-hub/forge, type imports, and apps without it", async () => {
    expect(await codes(forgeErrorImports, {
      "package.json": manifest({ "@vite-hub/forge": "*", "forges": "*" }),
      "server/utils/pr.ts": lines(
        "import { NotFoundError } from \"@vite-hub/forge\"",
        "import type { ForgeApiError } from \"forges\"",
        "import { repoRef } from \"forges\"",
        "export const missing = (error: unknown) => error instanceof NotFoundError && repoRef",
      ),
    })).toEqual([])
    expect(await codes(forgeErrorImports, {
      "server/utils/pr.ts": "import { NotFoundError } from \"forges\"\nexport { NotFoundError }\n",
    })).toEqual([])
  })
})

describe("vitehub/sandbox-runtime-options", () => {
  it("reports invalid runtimes and conflicting directories", async () => {
    expect(await codes(sandboxRuntimeOptions, {
      "server/utils/sandbox.ts": lines(
        "import { resolveSandbox } from \"vite-hub/sandbox\"",
        "export const a = await resolveSandbox({ runtime: \"cloudflare\" }, {})",
        "export const b = await resolveSandbox({ runtime: { kind: \"docker\" } }, {})",
        "export const c = await resolveSandbox({ runtime: \"trusted-host\", cwd: \"/srv\", checkout: { remote: \"r\", ref: \"main\", sha: \"x\" } }, {})",
        "export const d = await resolveSandbox({ runtime: \"crabbox\" }, {})",
      ),
      "server/agents/builder.ts": lines(
        "import { defineAgent } from \"vite-hub/agent\"",
        "export default defineAgent({ sandbox: { runtime: \"local\" } })",
      ),
    })).toEqual(["VHUB0027", "VHUB0027", "VHUB0027", "VHUB0027", "VHUB0027"])
  })

  it("accepts valid runtimes and definitions it cannot read", async () => {
    expect(await codes(sandboxRuntimeOptions, {
      "server/utils/sandbox.ts": lines(
        "import { resolveSandbox } from \"vite-hub/sandbox\"",
        "export const a = await resolveSandbox({ runtime: { kind: \"cloudflare\", namespace: env.SANDBOX } }, {})",
        "export const b = await resolveSandbox({ runtime: \"vercel\" }, {})",
        "export const c = await resolveSandbox({ runtime: \"crabbox\", cwd: \"/srv/app\" }, {})",
        "export const d = await resolveSandbox({ ...base, runtime: \"crabbox\" }, {})",
        "export const e = await resolveSandbox({ runtime: customRuntime }, {})",
      ),
    })).toEqual([])
  })
})

describe("vitehub/define-agent-from-vite-hub", () => {
  it("reports the owner-package defineAgent in a vite-hub app", async () => {
    expect(await codes(defineAgentFromViteHub, {
      "package.json": manifest({ "vite-hub": "*" }),
      "server/agents/support.ts": "import { defineAgent } from \"@vite-hub/agent\"\nexport default defineAgent({})\n",
    })).toEqual(["VHUB0028"])
  })

  it("accepts vite-hub/agent, type imports, and apps without vite-hub", async () => {
    expect(await codes(defineAgentFromViteHub, {
      "package.json": manifest({ "vite-hub": "*" }),
      "server/agents/support.ts": "import { defineAgent } from \"vite-hub/agent\"\nimport type { AgentDefinition } from \"@vite-hub/agent\"\nexport default defineAgent({})\n",
    })).toEqual([])
    expect(await codes(defineAgentFromViteHub, {
      "package.json": manifest({ "@vite-hub/agent": "*" }),
      "server/agents/support.ts": "import { defineAgent } from \"@vite-hub/agent\"\nexport default defineAgent({})\n",
    })).toEqual([])
  })
})

describe("vitehub/rate-limit-capability-limiter", () => {
  it("reports rateLimit without a limiter", async () => {
    expect(await codes(rateLimitCapabilityLimiter, {
      "server/agents/support.ts": lines(
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { rateLimit } from \"vite-hub/agent/capabilities\"",
        "export default defineAgent({ capabilities: [rateLimit({ limit: 20, window: \"1m\" }), rateLimit({ id: \"other\" })] })",
      ),
    })).toEqual(["VHUB0029", "VHUB0029"])
  })

  it("accepts a limiter and options it cannot read", async () => {
    expect(await codes(rateLimitCapabilityLimiter, {
      "server/agents/support.ts": lines(
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { rateLimit } from \"vite-hub/agent/capabilities\"",
        "export default defineAgent({ capabilities: [rateLimit({ limiter }), rateLimit({ ...shared }), rateLimit(options)] })",
      ),
    })).toEqual([])
  })
})

describe("vitehub/no-vitehub-plugin-in-nuxt", () => {
  it("reports vitehub() in vite.plugins next to the module", async () => {
    expect(await codes(noViteHubPluginInNuxt, {
      "nuxt.config.ts": lines(
        "import { vitehub } from \"vite-hub\"",
        "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], vite: { plugins: [vitehub({ preset: \"node\" })] } })",
      ),
    }, "nuxt")).toEqual(["VHUB0030"])
  })

  it("accepts module options and contributed plugins", async () => {
    expect(await codes(noViteHubPluginInNuxt, {
      "nuxt.config.ts": lines(
        "import { hubDb } from \"@vite-hub/database/vite\"",
        "export default defineNuxtConfig({ modules: [[\"vite-hub/nuxt\", { preset: \"node\" }]], vite: { plugins: [hubDb()] } })",
      ),
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/valid-vitehub-options", () => {
  it("reports options that do nothing in the Vite plugin", async () => {
    expect(await codes(validViteHubOptions, {
      "vite.config.ts": lines(
        "import { defineConfig } from \"vite\"",
        "import { vitehub } from \"vite-hub\"",
        "export default defineConfig({ plugins: [vitehub({ preset: \"vercel\", sandbox: true, devtools: false, sandboxTask: { provider: \"vercel\" }, queue: { provider: \"vercel\" }, env: { server: { token: 1 } } })] })",
      ),
    })).toEqual(Array(5).fill("VHUB0031"))
  })

  it("reports connections in the Nuxt module, in the vitehub key and in inline options", async () => {
    expect(await codes(validViteHubOptions, {
      "nuxt.config.ts": lines(
        "export default defineNuxtConfig({",
        "  modules: [[\"vite-hub/nuxt\", { connections: true }]],",
        "  vitehub: { preset: \"node\", connections: { management: true } },",
        "})",
      ),
    }, "nuxt")).toEqual(["VHUB0031", "VHUB0031"])
  })

  it("accepts valid options", async () => {
    expect(await codes(validViteHubOptions, {
      "vite.config.ts": lines(
        "import { defineConfig } from \"vite\"",
        "import { vitehub } from \"vite-hub\"",
        "export default defineConfig({ env: { server: {} }, plugins: [vitehub({ preset: \"vercel\", sandboxTask: true, queue: true, connections: true, env: { prefix: \"APP_\" } })] })",
      ),
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], vitehub: { preset: \"node\", env: { server: {} }, connections: false } })\n",
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/no-nuxthub-leftovers", () => {
  it("reports the NuxtHub module, hub key, and imports", async () => {
    expect(await codes(noNuxtHubLeftovers, {
      "package.json": JSON.stringify({ type: "module", dependencies: { "nuxt": "^4.0.0", "vue": "^3.5.0", "vite-hub": "*" } }),
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"@nuxthub/core\", \"vite-hub/nuxt\"], hub: { kv: true } })\n",
      "server/api/a.ts": "import { kv } from \"hub:kv\"\nimport { db } from \"@nuxthub/db\"\nexport { kv, db }\n",
    }, "nuxt")).toEqual(["VHUB0032", "VHUB0032", "VHUB0032", "VHUB0032"])
  })

  it("accepts ViteHub config and apps that still use only NuxtHub", async () => {
    expect(await codes(noNuxtHubLeftovers, {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"vite-hub/nuxt\"], vitehub: { preset: \"node\", kv: true } })\n",
      "server/api/a.ts": "import { kv } from \"vite-hub/kv\"\nexport { kv }\n",
    }, "nuxt")).toEqual([])
    expect(await codes(noNuxtHubLeftovers, {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: [\"@nuxthub/core\"], hub: { kv: true } })\n",
      "server/api/a.ts": "import { kv } from \"hub:kv\"\nexport { kv }\n",
    }, "nuxt")).toEqual([])
  })
})

describe("vitehub/no-removed-apis", () => {
  it("reports removed paths, renamed exports, and removed options", async () => {
    expect(await codes(noRemovedApis, {
      "server/utils/a.ts": lines(
        "import { runSandboxTask } from \"vite-hub/sandbox-task\"",
        "import { cms } from \"vite-hub/content/presets/cms\"",
        "import { cost, gmail } from \"vite-hub/agent/capabilities\"",
        "import { documents } from \"@vite-hub/content/collections\"",
        "export const tools = [cost(), gmail({ mode: \"draft\" })]",
        "export const pages = documents({ route: id => `/blog/${id}` })",
        "export { runSandboxTask, cms }",
      ),
      "src/Chat.vue": "<script setup lang=\"ts\">\nimport { AgentChat, AgentFileTree } from \"@vite-hub/ui\"\n</script>\n",
    })).toEqual(Array(7).fill("VHUB0033"))
  })

  it("accepts current APIs", async () => {
    expect(await codes(noRemovedApis, {
      "server/utils/a.ts": lines(
        "import { runSandboxTask } from \"vite-hub/sandbox/task\"",
        "import { cms } from \"vite-hub/cms\"",
        "import { usage, gmail } from \"vite-hub/agent/capabilities\"",
        "import { documents } from \"@vite-hub/content/collections\"",
        "export const tools = [usage(), gmail({ operations: [\"search\", \"read\", \"draft\"] })]",
        "export const pages = documents({ url: page => `/blog/${page.id}` })",
        "export { runSandboxTask, cms }",
      ),
      "src/Chat.vue": "<script setup lang=\"ts\">\nimport { Chat, FileTree } from \"@vite-hub/ui\"\n</script>\n",
    })).toEqual([])
  })
})

describe("vitehub/markdown-file-path", () => {
  it("reports relative string paths", async () => {
    expect(await codes(markdownFilePath, {
      "server/agents/review/agent.ts": "import { renderMarkdownFile } from \"vite-hub/markdown-template/file\"\nexport const prompt = await renderMarkdownFile(\"./reply.md\")\n",
    })).toEqual(["VHUB0034"])
  })

  it("accepts file URLs, absolute paths, and variables", async () => {
    expect(await codes(markdownFilePath, {
      "server/agents/review/agent.ts": lines(
        "import { renderMarkdownFile } from \"@vite-hub/markdown-template/file\"",
        "export const a = await renderMarkdownFile(new URL(\"./reply.md\", import.meta.url))",
        "export const b = await renderMarkdownFile(\"/srv/templates/reply.md\")",
        "export const c = await renderMarkdownFile(path)",
      ),
    })).toEqual([])
  })
})

describe("vitehub/comments-entry", () => {
  it("reports a default export next to comments", async () => {
    expect(await codes(commentsEntry, {
      "server/comments.ts": lines(
        "import { defineComments } from \"vite-hub/comments\"",
        "export const comments = defineComments({})",
        "export default defineComments({})",
      ),
    })).toEqual(["VHUB0035"])
  })

  it("reports defineComments exported under another name and a dynamic database", async () => {
    expect(await codes(commentsEntry, {
      "server/comments.ts": lines(
        "import { defineComments } from \"vite-hub/comments\"",
        "const name = \"analytics\"",
        "export const threads = defineComments({ database: name })",
      ),
    })).toEqual(["VHUB0035", "VHUB0035"])
  })

  it("accepts the live and operations forms", async () => {
    expect(await codes(commentsEntry, {
      "server/comments.ts": "import { defineComments } from \"vite-hub/comments\"\nexport const comments = defineComments({ database: \"analytics\" })\n",
    })).toEqual([])
    expect(await codes(commentsEntry, {
      "server/comments.ts": "import { defineComments } from \"vite-hub/comments\"\nexport default defineComments({})\n",
      "server/utils/comments.ts": "import { defineComments } from \"vite-hub/comments\"\nexport const threads = defineComments({ database: name })\n",
    })).toEqual([])
  })
})
