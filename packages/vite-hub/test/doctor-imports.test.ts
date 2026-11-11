import { describe, expect, it, vi } from "vitest"
import { runRuleFixture } from "vite-doctor/testkit"

import { preferViteHubImports } from "../src/doctor.ts"
import { doctorTestTimeout } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

const manifest = (fields: Record<string, unknown>) => JSON.stringify({ type: "module", ...fields })
const app = manifest({ dependencies: { "vite": "^8.0.0", "vite-hub": "*", "@vite-hub/blob": "*", "@vite-hub/rate-limit": "*" } })

async function report(files: Record<string, string>) {
  const result = await runRuleFixture({ rule: preferViteHubImports, framework: "vite", files })
  return result.diagnostics.map(diagnostic => diagnostic.suggestion)
}

describe("vitehub/prefer-vite-hub-imports", () => {
  it("names the vite-hub path for each owner import that has one", async () => {
    const suggestions = await report({
      "package.json": app,
      "server/api/upload.post.ts": [
        "import { blob } from \"@vite-hub/blob\"",
        "import { memoryRateLimitDriver } from \"@vite-hub/rate-limit/drivers/memory\"",
        "import type { AuthEventsConfiguration } from \"@vite-hub/auth\"",
        "export * from \"@vite-hub/kv\"",
        "const { runWorkflow } = await import(\"@vite-hub/workflow\")",
        "export { blob, memoryRateLimitDriver, runWorkflow }",
        "export type { AuthEventsConfiguration }",
      ].join("\n"),
      "src/presence.ts": "import { connectRealtimeRoom } from \"@vite-hub/realtime/client\"\nexport { connectRealtimeRoom }\n",
    })
    expect(suggestions.sort()).toEqual(["auth", "blob", "kv", "rate-limit/drivers/memory", "realtime/client", "workflow"]
      .map(path => `Import \`vite-hub/${path}\` instead of \`@vite-hub/${path}\`.`))
  })

  it("accepts owner paths that have no vite-hub path", async () => {
    expect(await report({
      "package.json": app,
      // A Vite integration of one owner package, used without `vitehub()`.
      "vite.config.ts": "import { hubBlob } from \"@vite-hub/blob/vite\"\nexport default { plugins: [hubBlob()] }\n",
      // Plugin authoring, as in the Database and Schedule docs.
      "my-package/vite.ts": "import type { DatabaseContributingPlugin } from \"@vite-hub/database/vite\"\nexport type Plugin = DatabaseContributingPlugin\n",
      "server/utils/notes.ts": "import { connectDatabase } from \"@vite-hub/database/connect\"\nexport const db = connectDatabase(\"env:NOTES_DATABASE_URL\")\n",
      "server/api/a.ts": "import { blob } from \"vite-hub/blob\"\nimport { kv } from \"vite-hub/kv\"\nexport { blob, kv }\n",
      ".vitehub/blob/runtime.ts": "export { blob } from \"@vite-hub/blob\"\n",
    })).toEqual([])
  })

  it("accepts apps that install an owner package without vite-hub", async () => {
    // A docs site on @vite-hub/docs, and Comments used alone.
    expect(await report({
      "package.json": manifest({ dependencies: { "@vite-hub/docs": "*", "@vite-hub/comments": "*" } }),
      "docs.parser.ts": "import type { DocsParserOptions } from \"@vite-hub/docs/server\"\nexport default {} satisfies DocsParserOptions\n",
      "server/comments.ts": "import { defineComments } from \"@vite-hub/comments\"\nexport const comments = defineComments({})\n",
    })).toEqual([])
  })

  it("accepts the source of vite-hub and its owner packages", async () => {
    expect(await report({
      "package.json": manifest({ name: "vite-hub", dependencies: { "@vite-hub/runtime": "*" } }),
      "src/blob.ts": "export * from \"@vite-hub/blob\"\n",
    })).toEqual([])
    expect(await report({
      "package.json": manifest({ name: "@vite-hub/presets", devDependencies: { "vite-hub": "*" } }),
      "src/labeller.ts": "import { defineAgent } from \"@vite-hub/agent\"\nexport const labeller = defineAgent({})\n",
    })).toEqual([])
  })
})
